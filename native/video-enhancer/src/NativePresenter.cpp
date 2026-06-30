#include "NativePresenter.h"
#include <cstdio>
#include <chrono>
#include <d3d11_1.h>
#include <dxgi1_4.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

namespace screenlink::video {

// ── Statics ──────────────────────────────────────────────────────────────

bool NativePresenter::s_windowClassRegistered = false;
const wchar_t* NativePresenter::kWindowClassName = L"ScreenLinkNativePresenter";

// ── Global presenter diagnostics ────────────────────────────────────────

static PresenterDiagnostics g_presenterDiag;

PresenterDiagnostics& GetPresenterDiagnostics() {
    return g_presenterDiag;
}

void PresenterDiagnostics::RecordPresent(uint64_t elapsedUs, bool success) {
    if (success) {
        framesPresented++;
    } else {
        presentErrors++;
    }
    lastPresentUs = elapsedUs;
    if (elapsedUs > maxPresentUs) maxPresentUs = elapsedUs;
    totalPresentUs.fetch_add(elapsedUs);
}

void PresenterDiagnostics::Reset() {
    framesPresented = 0;
    framesDropped = 0;
    presentErrors = 0;
    lastPresentUs = 0;
    maxPresentUs = 0;
    totalPresentUs = 0;
    presenterResizes = 0;
    presenterAttachCount = 0;
    presenterDetachCount = 0;
}

PresenterSnapshot NativePresenter::GetSnapshot() const {
    PresenterSnapshot snap;
    snap.framesPresented = diag_.framesPresented.load();
    snap.framesDropped = diag_.framesDropped.load();
    snap.presentErrors = diag_.presentErrors.load();
    snap.lastPresentUs = diag_.lastPresentUs.load();
    snap.maxPresentUs = diag_.maxPresentUs.load();
    uint64_t total = diag_.totalPresentUs.load();
    uint64_t count = diag_.framesPresented.load();
    snap.avgPresentUs = count > 0 ? total / count : 0;
    snap.presenterResizes = diag_.presenterResizes.load();
    snap.presenterAttachCount = diag_.presenterAttachCount.load();
    snap.presenterDetachCount = diag_.presenterDetachCount.load();
    snap.active = active_;
    return snap;
}

// ── Window procedure ────────────────────────────────────────────────────

LRESULT CALLBACK NativePresenter::PresenterWndProc(
    HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
        case WM_ERASEBKGND:
            return 1; // Prevent flicker
        case WM_PAINT: {
            PAINTSTRUCT ps;
            BeginPaint(hwnd, &ps);
            // Presenter surface is drawn via D3D swapchain, not GDI
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_NCHITTEST:
            return HTTRANSPARENT; // Pass through all mouse events
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE; // Never activate
        case WM_SETFOCUS:
            // Redirect focus to owner if possible
            if (GetParent(hwnd)) {
                SetFocus(GetParent(hwnd));
            }
            return 0;
        case WM_DESTROY:
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

// ── Construction / Destruction ──────────────────────────────────────────

NativePresenter::NativePresenter() = default;

NativePresenter::~NativePresenter() {
    Detach();
}

// ── Attach: create presenter window and D3D11 resources ────────────────

bool NativePresenter::Attach(HWND ownerHwnd, uint32_t initialWidth, uint32_t initialHeight) {
    if (active_) {
        Detach();
    }

    if (!ownerHwnd || !IsWindow(ownerHwnd)) {
        fprintf(stderr, "[NativePresenter] Invalid owner HWND\n");
        return false;
    }

    ownerHwnd_ = ownerHwnd;
    surfaceWidth_ = initialWidth > 0 ? initialWidth : 1;
    surfaceHeight_ = initialHeight > 0 ? initialHeight : 1;

    // Register window class once
    if (!s_windowClassRegistered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(WNDCLASSEXW);
        wc.style = CS_HREDRAW | CS_VREDRAW | CS_NOCLOSE;
        wc.lpfnWndProc = PresenterWndProc;
        wc.hInstance = GetModuleHandleW(nullptr);
        wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512)); // IDC_ARROW
        wc.hbrBackground = nullptr; // No background brush — D3D paints
        wc.lpszClassName = kWindowClassName;
        if (!RegisterClassExW(&wc)) {
            DWORD err = GetLastError();
            if (err != ERROR_CLASS_ALREADY_EXISTS) {
                fprintf(stderr, "[NativePresenter] RegisterClassExW failed: %lu\n", err);
                return false;
            }
        }
        s_windowClassRegistered = true;
    }

    // Determine initial position relative to owner
    RECT ownerRect;
    GetClientRect(ownerHwnd, &ownerRect);

    // Create presenter window: child of owner, non-activating, transparent to input
    presenterWnd_ = CreateWindowExW(
        WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP,
        kWindowClassName,
        L"ScreenLink Native Presenter",
        WS_CHILD | WS_VISIBLE,
        0, 0,
        static_cast<int>(surfaceWidth_),
        static_cast<int>(surfaceHeight_),
        ownerHwnd_,
        nullptr,
        GetModuleHandleW(nullptr),
        nullptr
    );

    if (!presenterWnd_) {
        fprintf(stderr, "[NativePresenter] CreateWindowExW failed: %lu\n", GetLastError());
        ownerHwnd_ = nullptr;
        return false;
    }

    // Set layered window attributes: 255 opacity, transparent color key not needed
    SetLayeredWindowAttributes(presenterWnd_, 0, 255, LWA_ALPHA);

    // Create D3D11 device and swapchain
    if (!CreateD3DResources(ownerHwnd_, surfaceWidth_, surfaceHeight_)) {
        DestroyWindow(presenterWnd_);
        presenterWnd_ = nullptr;
        ownerHwnd_ = nullptr;
        return false;
    }

    active_ = true;
    diag_.presenterAttachCount++;

    printf("[NativePresenter] Attached: %ux%u, owner=0x%p, presenter=0x%p\n",
           surfaceWidth_, surfaceHeight_,
           reinterpret_cast<void*>(ownerHwnd_),
           reinterpret_cast<void*>(presenterWnd_));

    return true;
}

// ── Detach: destroy resources ──────────────────────────────────────────

void NativePresenter::Detach() {
    if (!active_) return;

    printf("[NativePresenter] Detaching...\n");

    DestroyD3DResources();

    if (presenterWnd_ && IsWindow(presenterWnd_)) {
        DestroyWindow(presenterWnd_);
    }

    presenterWnd_ = nullptr;
    ownerHwnd_ = nullptr;
    surfaceWidth_ = 0;
    surfaceHeight_ = 0;
    surfaceX_ = 0;
    surfaceY_ = 0;
    active_ = false;

    diag_.presenterDetachCount++;
    printf("[NativePresenter] Detached\n");
}

// ── Bounds / Visibility ────────────────────────────────────────────────

void NativePresenter::UpdateBounds(int32_t x, int32_t y, uint32_t width, uint32_t height) {
    if (!active_ || !presenterWnd_) return;

    surfaceX_ = x;
    surfaceY_ = y;

    // Clamp to minimum 1x1
    if (width == 0) width = 1;
    if (height == 0) height = 1;

    bool sizeChanged = (width != surfaceWidth_ || height != surfaceHeight_);
    surfaceWidth_ = width;
    surfaceHeight_ = height;

    // Move and resize window
    SetWindowPos(presenterWnd_, HWND_TOP,
                 x, y,
                 static_cast<int>(width),
                 static_cast<int>(height),
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);

    if (sizeChanged) {
        ResizeSwapchain(width, height);
        diag_.RecordResize();
        printf("[NativePresenter] Resized to %ux%u at (%d, %d)\n", width, height, x, y);
    }
}

void NativePresenter::SetVisible(bool visible) {
    if (!active_ || !presenterWnd_) return;
    visible_ = visible;
    ShowWindow(presenterWnd_, visible ? SW_SHOWNA : SW_HIDE);
}

// ── Present from D3D11 texture (GPU-resident) ──────────────────────────

bool NativePresenter::PresentFrame(ID3D11Texture2D* srcTexture) {
    if (!active_ || !swapChain_ || !backBuffer_) {
        return false;
    }

    auto t_start = std::chrono::high_resolution_clock::now();

    ComPtr<ID3D11DeviceContext> context;
    d3dDevice_->GetImmediateContext(&context);
    if (!context) {
        diag_.RecordPresent(0, false);
        return false;
    }

    // Copy source texture to backbuffer
    D3D11_BOX srcBox = {};
    srcBox.left = 0;
    srcBox.top = 0;
    srcBox.right = surfaceWidth_;
    srcBox.bottom = surfaceHeight_;
    srcBox.front = 0;
    srcBox.back = 1;

    D3D11_TEXTURE2D_DESC srcDesc;
    srcTexture->GetDesc(&srcDesc);

    if (srcDesc.Format == DXGI_FORMAT_B8G8R8A8_UNORM ||
        srcDesc.Format == DXGI_FORMAT_R8G8B8A8_UNORM) {
        // Same-format copy
        context->CopySubresourceRegion(backBuffer_.Get(), 0, 0, 0, 0,
                                        srcTexture, 0, &srcBox);
    } else {
        // Format mismatch — skip present
        fprintf(stderr, "[NativePresenter] Unsupported source format: %d\n", srcDesc.Format);
        diag_.RecordPresent(0, false);
        return false;
    }

    // Present the swapchain
    HRESULT hr = swapChain_->Present(1, 0); // VSync enabled (1 = wait for VBlank)
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] Present failed: 0x%08lX\n", hr);
        diag_.framesDropped++;
        diag_.RecordPresent(0, false);

        // Try to recover by recreating swapchain
        if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
            fprintf(stderr, "[NativePresenter] Device lost — attempting recovery\n");
            DestroyD3DResources();
            if (ownerHwnd_) {
                CreateD3DResources(ownerHwnd_, surfaceWidth_, surfaceHeight_);
            }
        }
        return false;
    }

    auto t_end = std::chrono::high_resolution_clock::now();
    uint64_t elapsedUs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(t_end - t_start).count());
    diag_.RecordPresent(elapsedUs, true);

    return true;
}

// ── Present from raw RGBA8 pixel data via GPU upload (GPU-to-GPU fallback) ──

bool NativePresenter::PresentFrameFromCudaBuffer(const void* srcData,
                                                   uint32_t width,
                                                   uint32_t height,
                                                   uint32_t stride) {
    if (!active_ || !swapChain_ || !backBuffer_) {
        return false;
    }

    auto t_start = std::chrono::high_resolution_clock::now();

    // Ensure staging texture exists and matches dimensions
    if (!stagingTexture_ ||
        surfaceWidth_ != width ||
        surfaceHeight_ != height) {

        D3D11_TEXTURE2D_DESC stagingDesc = {};
        stagingDesc.Width = width;
        stagingDesc.Height = height;
        stagingDesc.MipLevels = 1;
        stagingDesc.ArraySize = 1;
        stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        stagingDesc.SampleDesc.Count = 1;
        stagingDesc.SampleDesc.Quality = 0;
        stagingDesc.Usage = D3D11_USAGE_DEFAULT;
        stagingDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
        stagingDesc.CPUAccessFlags = 0;

        HRESULT hr = d3dDevice_->CreateTexture2D(&stagingDesc, nullptr, &stagingTexture_);
        if (FAILED(hr)) {
            fprintf(stderr, "[NativePresenter] CreateTexture2D (staging) failed: 0x%08lX\n", hr);
            diag_.RecordPresent(0, false);
            return false;
        }
    }

    // Upload data via UpdateSubresource (GPU upload from CPU buffer)
    // This is the GPU-to-GPU fallback path — data originates from CUDA GPU memory
    // but must be copied through CPU. The primary GPU-resident path uses
    // PresentFrame() with a D3D11 texture directly.
    ComPtr<ID3D11DeviceContext> context;
    d3dDevice_->GetImmediateContext(&context);

    UINT srcRowPitch = stride > 0 ? stride : width * 4;
    context->UpdateSubresource(stagingTexture_.Get(), 0, nullptr, srcData, srcRowPitch, 0);

    // Copy staging texture to backbuffer
    D3D11_BOX srcBox = {};
    srcBox.left = 0;
    srcBox.top = 0;
    srcBox.right = width;
    srcBox.bottom = height;
    srcBox.front = 0;
    srcBox.back = 1;

    context->CopySubresourceRegion(backBuffer_.Get(), 0, 0, 0, 0,
                                    stagingTexture_.Get(), 0, &srcBox);

    // Present
    HRESULT hr = swapChain_->Present(1, 0);
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] Present (fallback) failed: 0x%08lX\n", hr);
        diag_.framesDropped++;
        diag_.RecordPresent(0, false);
        return false;
    }

    auto t_end = std::chrono::high_resolution_clock::now();
    uint64_t elapsedUs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(t_end - t_start).count());
    diag_.RecordPresent(elapsedUs, true);

    return true;
}

// ── CUDA-D3D11 interop support ─────────────────────────────────────────
//
// These functions are loaded dynamically from cuda.dll to avoid a hard
// link-time dependency when the NVIDIA VFX SDK is not present.

// Forward declarations for CUDA types (loaded dynamically)
// These match the actual CUDA types but avoid requiring cuda.h.
typedef int CUresult;                            // cudaError_t is int
typedef void* CUdeviceptr;                       // CUDA device pointer
typedef void* cudaGraphicsResource_t;            // Opaque handle
typedef void* cudaArray_t;                       // Opaque handle
typedef void* CUstream;                          // Opaque handle
// cudaMemcpyKind: 0=HostToHost, 1=HostToDevice, 2=DeviceToDevice, 3=DeviceToHost

struct CudaInterop {
    HMODULE cudaDll = nullptr;

    // Function pointer types (using generic int/void* for CUDA types)
    using CudaGraphicsD3D11RegisterResource_t = CUresult(*)(
        cudaGraphicsResource_t*, ID3D11Resource*, unsigned int);
    using CudaGraphicsMapResources_t = CUresult(*)(int, cudaGraphicsResource_t*, CUstream);
    using CudaGraphicsSubResourceGetMappedArray_t = CUresult(*)(
        cudaArray_t*, cudaGraphicsResource_t, unsigned int, unsigned int);
    using CudaMemcpy2DToArray_t = CUresult(*)(
        cudaArray_t, size_t, size_t, const void*, size_t, size_t, size_t, int);
    using CudaGraphicsUnmapResources_t = CUresult(*)(int, cudaGraphicsResource_t*, CUstream);
    using CudaGraphicsUnregisterResource_t = CUresult(*)(cudaGraphicsResource_t);

    CudaGraphicsD3D11RegisterResource_t CudaGraphicsD3D11RegisterResource = nullptr;
    CudaGraphicsMapResources_t CudaGraphicsMapResources = nullptr;
    CudaGraphicsSubResourceGetMappedArray_t CudaGraphicsSubResourceGetMappedArray = nullptr;
    CudaMemcpy2DToArray_t CudaMemcpy2DToArray = nullptr;
    CudaGraphicsUnmapResources_t CudaGraphicsUnmapResources = nullptr;
    CudaGraphicsUnregisterResource_t CudaGraphicsUnregisterResource = nullptr;

    bool Load() {
        if (cudaDll) return true;
        cudaDll = LoadLibraryW(L"cuda.dll");
        if (!cudaDll) return false;

        CudaGraphicsD3D11RegisterResource =
            reinterpret_cast<CudaGraphicsD3D11RegisterResource_t>(
                GetProcAddress(cudaDll, "cudaGraphicsD3D11RegisterResource"));
        CudaGraphicsMapResources =
            reinterpret_cast<CudaGraphicsMapResources_t>(
                GetProcAddress(cudaDll, "cudaGraphicsMapResources"));
        CudaGraphicsSubResourceGetMappedArray =
            reinterpret_cast<CudaGraphicsSubResourceGetMappedArray_t>(
                GetProcAddress(cudaDll, "cudaGraphicsSubResourceGetMappedArray"));
        CudaMemcpy2DToArray =
            reinterpret_cast<CudaMemcpy2DToArray_t>(
                GetProcAddress(cudaDll, "cudaMemcpy2DToArray"));
        CudaGraphicsUnmapResources =
            reinterpret_cast<CudaGraphicsUnmapResources_t>(
                GetProcAddress(cudaDll, "cudaGraphicsUnmapResources"));
        CudaGraphicsUnregisterResource =
            reinterpret_cast<CudaGraphicsUnregisterResource_t>(
                GetProcAddress(cudaDll, "cudaGraphicsUnregisterResource"));

        if (!CudaGraphicsD3D11RegisterResource || !CudaGraphicsMapResources ||
            !CudaGraphicsSubResourceGetMappedArray || !CudaMemcpy2DToArray ||
            !CudaGraphicsUnmapResources || !CudaGraphicsUnregisterResource) {
            FreeLibrary(cudaDll);
            cudaDll = nullptr;
            return false;
        }
        return true;
    }

    ~CudaInterop() {
        if (cudaDll) {
            FreeLibrary(cudaDll);
            cudaDll = nullptr;
        }
    }
};

static CudaInterop g_cudaInterop;
static bool g_cudaInteropLoaded = false;

// ── CUDA-D3D11 interop path (GPU-resident, no CPU roundtrip) ──────────

bool NativePresenter::PresentFrameFromCudaGpuBuffer(const void* cudaDevicePtr,
                                                      uint32_t width,
                                                      uint32_t height,
                                                      uint32_t stride) {
    if (!active_ || !swapChain_ || !backBuffer_ || !cudaDevicePtr) {
        return false;
    }

    auto t_start = std::chrono::high_resolution_clock::now();

    // Ensure CUDA interop is loaded
    if (!g_cudaInteropLoaded) {
        g_cudaInteropLoaded = g_cudaInterop.Load();
        if (!g_cudaInteropLoaded) {
            fprintf(stderr, "[NativePresenter] CUDA interop not available, falling back\n");
            return false;
        }
    }

    // Create a D3D11 staging texture compatible with CUDA interop
    D3D11_TEXTURE2D_DESC stagingDesc = {};
    stagingDesc.Width = width;
    stagingDesc.Height = height;
    stagingDesc.MipLevels = 1;
    stagingDesc.ArraySize = 1;
    stagingDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    stagingDesc.SampleDesc.Count = 1;
    stagingDesc.SampleDesc.Quality = 0;
    stagingDesc.Usage = D3D11_USAGE_DEFAULT;
    stagingDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    stagingDesc.CPUAccessFlags = 0;
    stagingDesc.MiscFlags = D3D11_RESOURCE_MISC_SHARED; // Required for CUDA interop

    ComPtr<ID3D11Texture2D> interopTexture;
    HRESULT hr = d3dDevice_->CreateTexture2D(&stagingDesc, nullptr, &interopTexture);
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] CreateTexture2D (CUDA interop) failed: 0x%08lX\n", hr);
        return false;
    }

    // Register the D3D11 texture with CUDA
    cudaGraphicsResource_t cudaResource = nullptr;
    CUresult cuResult = g_cudaInterop.CudaGraphicsD3D11RegisterResource(
        &cudaResource, interopTexture.Get(), 0); // 0 = None flags

    if (cuResult != 0) {
        fprintf(stderr, "[NativePresenter] cudaGraphicsD3D11RegisterResource failed: %d\n",
                static_cast<int>(cuResult));
        return false;
    }

    // Map the resource for CUDA access
    cuResult = g_cudaInterop.CudaGraphicsMapResources(1, &cudaResource, nullptr);
    if (cuResult != 0) {
        g_cudaInterop.CudaGraphicsUnregisterResource(cudaResource);
        fprintf(stderr, "[NativePresenter] cudaGraphicsMapResources failed: %d\n",
                static_cast<int>(cuResult));
        return false;
    }

    // Get the mapped array
    cudaArray_t cudaArray = nullptr;
    cuResult = g_cudaInterop.CudaGraphicsSubResourceGetMappedArray(
        &cudaArray, cudaResource, 0, 0);
    if (cuResult != 0 || !cudaArray) {
        g_cudaInterop.CudaGraphicsUnmapResources(1, &cudaResource, nullptr);
        g_cudaInterop.CudaGraphicsUnregisterResource(cudaResource);
        fprintf(stderr, "[NativePresenter] CudaGraphicsSubResourceGetMappedArray failed: %d\n",
                static_cast<int>(cuResult));
        return false;
    }

    // Copy from CUDA device pointer to the mapped D3D11 texture array
    UINT srcRowPitch = stride > 0 ? stride : width * 4;
    cuResult = g_cudaInterop.CudaMemcpy2DToArray(
        cudaArray,
        0, 0,                   // Offset in array
        cudaDevicePtr,
        srcRowPitch,            // Source row pitch (bytes)
        width * 4,              // Width to copy (bytes)
        height,                 // Height to copy (rows)
        2);                     // cudaMemcpyDeviceToDevice = 2

    if (cuResult != 0) {
        g_cudaInterop.CudaGraphicsUnmapResources(1, &cudaResource, nullptr);
        g_cudaInterop.CudaGraphicsUnregisterResource(cudaResource);
        fprintf(stderr, "[NativePresenter] cudaMemcpy2DToArray failed: %d\n",
                static_cast<int>(cuResult));
        return false;
    }

    // Unmap the resource
    g_cudaInterop.CudaGraphicsUnmapResources(1, &cudaResource, nullptr);

    // Unregister the resource (we'll create a new one next time)
    g_cudaInterop.CudaGraphicsUnregisterResource(cudaResource);

    // Copy interop texture to backbuffer and present
    ComPtr<ID3D11DeviceContext> context;
    d3dDevice_->GetImmediateContext(&context);

    D3D11_BOX srcBox = {};
    srcBox.left = 0;
    srcBox.top = 0;
    srcBox.right = std::min(width, surfaceWidth_);
    srcBox.bottom = std::min(height, surfaceHeight_);
    srcBox.front = 0;
    srcBox.back = 1;

    context->CopySubresourceRegion(backBuffer_.Get(), 0, 0, 0, 0,
                                    interopTexture.Get(), 0, &srcBox);

    hr = swapChain_->Present(1, 0);
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] Present (CUDA interop) failed: 0x%08lX\n", hr);
        diag_.framesDropped++;
        diag_.RecordPresent(0, false);
        return false;
    }

    auto t_end = std::chrono::high_resolution_clock::now();
    uint64_t elapsedUs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(t_end - t_start).count());
    diag_.RecordPresent(elapsedUs, true);

    return true;
}

// ── D3D11 resource management ──────────────────────────────────────────

bool NativePresenter::CreateD3DResources(HWND ownerHwnd, uint32_t width, uint32_t height) {
    DestroyD3DResources();

    // Create D3D11 device with debug layer only in debug builds
    UINT createFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
    createFlags |= D3D11_CREATE_DEVICE_DEBUG;
#endif

    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };

    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL selectedLevel;

    HRESULT hr = D3D11CreateDevice(
        nullptr,                          // Default adapter
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,                          // Software rasterizer DLL
        createFlags,
        featureLevels,
        ARRAYSIZE(featureLevels),
        D3D11_SDK_VERSION,
        &device,
        &selectedLevel,
        &context
    );

    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] D3D11CreateDevice failed: 0x%08lX\n", hr);
        return false;
    }

    // Get DXGI device for swapchain creation
    ComPtr<IDXGIDevice> dxgiDevice;
    hr = device.As(&dxgiDevice);
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] QueryInterface(IDXGIDevice) failed: 0x%08lX\n", hr);
        return false;
    }

    d3dDevice_ = device;
    d3dContext_ = context;

    printf("[NativePresenter] D3D11 device created: feature level %d.%d\n",
           (selectedLevel >> 12) & 0xF, (selectedLevel >> 8) & 0xF);

    return CreateSwapchain(ownerHwnd, width, height);
}

void NativePresenter::DestroyD3DResources() {
    stagingTexture_.Reset();
    backBuffer_.Reset();
    swapChain_.Reset();

    if (d3dContext_) {
        d3dContext_->ClearState();
        d3dContext_->Flush();
        d3dContext_.Reset();
    }
    d3dDevice_.Reset();
}

bool NativePresenter::CreateSwapchain(HWND ownerHwnd, uint32_t width, uint32_t height) {
    if (!d3dDevice_) return false;

    ComPtr<IDXGIDevice> dxgiDevice;
    HRESULT hr = d3dDevice_.As(&dxgiDevice);
    if (FAILED(hr)) return false;

    ComPtr<IDXGIAdapter> adapter;
    hr = dxgiDevice->GetAdapter(&adapter);
    if (FAILED(hr)) return false;

    ComPtr<IDXGIFactory2> factory;
    hr = adapter->GetParent(IID_PPV_ARGS(&factory));
    if (FAILED(hr)) return false;

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.Stereo = FALSE;
    desc.SampleDesc.Count = 1;
    desc.SampleDesc.Quality = 0;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2; // Double buffered
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

    hr = factory->CreateSwapChainForHwnd(
        d3dDevice_.Get(),
        presenterWnd_ ? presenterWnd_ : ownerHwnd,
        &desc,
        nullptr, // Fullscreen desc
        nullptr, // Restrict to output
        &swapChain_
    );

    if (FAILED(hr)) {
        // Fall back to legacy flip sequential if flip discard not supported
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        hr = factory->CreateSwapChainForHwnd(
            d3dDevice_.Get(),
            presenterWnd_ ? presenterWnd_ : ownerHwnd,
            &desc,
            nullptr,
            nullptr,
            &swapChain_
        );
    }

    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] CreateSwapChainForHwnd failed: 0x%08lX\n", hr);
        return false;
    }

    // Get backbuffer
    hr = swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer_));
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] GetBuffer (backbuffer) failed: 0x%08lX\n", hr);
        return false;
    }

    // Disable ALT+ENTER fullscreen toggle
    ComPtr<IDXGIFactory> factoryBase;
    factory.As(&factoryBase);
    if (factoryBase) {
        factoryBase->MakeWindowAssociation(presenterWnd_ ? presenterWnd_ : ownerHwnd,
                                           DXGI_MWA_NO_ALT_ENTER);
    }

    printf("[NativePresenter] Swapchain created: %ux%u\n", width, height);
    return true;
}

bool NativePresenter::ResizeSwapchain(uint32_t width, uint32_t height) {
    if (!swapChain_) return false;

    // Release backbuffer before resize
    backBuffer_.Reset();
    stagingTexture_.Reset();

    HRESULT hr = swapChain_->ResizeBuffers(
        2, // Buffer count
        width,
        height,
        DXGI_FORMAT_B8G8R8A8_UNORM,
        DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT
    );

    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] ResizeBuffers failed: 0x%08lX\n", hr);
        return false;
    }

    hr = swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer_));
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] GetBuffer after resize failed: 0x%08lX\n", hr);
        return false;
    }

    printf("[NativePresenter] Swapchain resized: %ux%u\n", width, height);
    return true;
}

} // namespace screenlink::video
