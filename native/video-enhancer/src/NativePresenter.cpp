#include "NativePresenter.h"

// Guard against Windows min/max macro conflicts (CMake provides NOMINMAX,
// but this ensures correctness if the file is compiled outside CMake).
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <cstdio>
#include <chrono>
#include <algorithm>

#include <d3d11_1.h>
#include <dxgi1_4.h>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")

// ── CUDA headers (official, driver API) ─────────────────────────────────
// When SCREENLINK_ENABLE_CUDA_PRESENTER is defined, we use the official
// CUDA driver API (cu* functions) declared in <cuda.h> and <cudaD3D11.h>.
// The import library cuda.lib is linked by CMakeLists.txt when the toggle
// is enabled.  Using the driver API ensures the binary only depends on
// cuda.dll (present with any NVIDIA driver) rather than cudart.dll.
#ifdef SCREENLINK_ENABLE_CUDA_PRESENTER
#include <cuda.h>
#include <cudaD3D11.h>
#endif

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
    queueEnqueued = 0;
    queueDequeued = 0;
    queueOverflowDrops = 0;
    staleGenerationDrops = 0;
    queueDepth = 0;
    queueMaxDepth = 0;
}

PresenterSnapshot NativePresenter::GetSnapshot() const {
    PresenterSnapshot snap{};
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

    snap.queueEnqueued = diag_.queueEnqueued.load();
    snap.queueDequeued = diag_.queueDequeued.load();
    snap.queueOverflowDrops = diag_.queueOverflowDrops.load();
    snap.staleGenerationDrops = diag_.staleGenerationDrops.load();
    snap.queueDepth = diag_.queueDepth.load();
    snap.queueMaxDepth = diag_.queueMaxDepth.load();

    snap.active = active_.load();
    return snap;
}

// ── Window procedure ────────────────────────────────────────────────────

LRESULT CALLBACK NativePresenter::PresenterWndProc(
    HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg) {
        case WM_ERASEBKGND:
            return 1;
        case WM_PAINT: {
            PAINTSTRUCT ps;
            BeginPaint(hwnd, &ps);
            EndPaint(hwnd, &ps);
            return 0;
        }
        case WM_NCHITTEST:
            return HTTRANSPARENT;
        case WM_MOUSEACTIVATE:
            return MA_NOACTIVATE;
        case WM_SETFOCUS:
            if (GetParent(hwnd)) {
                SetFocus(GetParent(hwnd));
            }
            return 0;
        case WM_DESTROY:
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

// ── PresenterQueue ──────────────────────────────────────────────────────

PresenterQueue::PresenterQueue(uint32_t capacity)
    : capacity_(capacity)
    , slots_(std::make_unique<uint32_t[]>(capacity))
{
    for (uint32_t i = 0; i < capacity; ++i) {
        slots_[i] = UINT32_MAX;
    }
}

bool PresenterQueue::TryPush(uint32_t slotIndex) {
    uint64_t t = tail_.load(std::memory_order_relaxed);
    uint64_t h = head_.load(std::memory_order_acquire);

    if (t - h >= capacity_) {
        return false; // Full
    }

    slots_[t % capacity_] = slotIndex;
    tail_.store(t + 1, std::memory_order_release);
    return true;
}

bool PresenterQueue::TryPop(uint32_t& slotIndex) {
    uint64_t h = head_.load(std::memory_order_relaxed);
    uint64_t t = tail_.load(std::memory_order_acquire);

    if (h >= t) {
        return false; // Empty
    }

    slotIndex = slots_[h % capacity_];
    head_.store(h + 1, std::memory_order_release);
    return true;
}

uint32_t PresenterQueue::Size() const {
    uint64_t t = tail_.load(std::memory_order_acquire);
    uint64_t h = head_.load(std::memory_order_relaxed);
    uint64_t sz = t - h;
    return sz > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(sz);
}

// ── Construction / Destruction ──────────────────────────────────────────

NativePresenter::NativePresenter() = default;

NativePresenter::~NativePresenter() {
    Detach();
}

// ── Attach: create presenter window, D3D11, persistent slots, start thread ──

bool NativePresenter::Attach(HWND ownerHwnd, uint32_t initialWidth, uint32_t initialHeight) {
    if (active_.load()) {
        Detach();
    }

    if (!ownerHwnd || !IsWindow(ownerHwnd)) {
        fprintf(stderr, "[NativePresenter] Invalid owner HWND\n");
        return false;
    }

    ownerHwnd_ = ownerHwnd;
    surfaceWidth_ = initialWidth > 0 ? initialWidth : 1;
    surfaceHeight_ = initialHeight > 0 ? initialHeight : 1;

    // ── Register window class once ──
    if (!s_windowClassRegistered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(WNDCLASSEXW);
        wc.style = CS_HREDRAW | CS_VREDRAW | CS_NOCLOSE;
        wc.lpfnWndProc = PresenterWndProc;
        wc.hInstance = GetModuleHandleW(nullptr);
        wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
        wc.hbrBackground = nullptr;
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

    // ── Create presenter window ──
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

    SetLayeredWindowAttributes(presenterWnd_, 0, 255, LWA_ALPHA);

    // ── Create D3D11 device and swapchain ──
    if (!CreateD3DResources(ownerHwnd_, surfaceWidth_, surfaceHeight_)) {
        DestroyWindow(presenterWnd_);
        presenterWnd_ = nullptr;
        ownerHwnd_ = nullptr;
        return false;
    }

    // ── Create persistent frame slots ──
    if (!CreatePersistentSlots(surfaceWidth_, surfaceHeight_, surfaceWidth_ * 4)) {
        fprintf(stderr, "[NativePresenter] Failed to create persistent slots\n");
        DestroyD3DResources();
        DestroyWindow(presenterWnd_);
        presenterWnd_ = nullptr;
        ownerHwnd_ = nullptr;
        return false;
    }

    // ── Start the presenter thread ──
    StartPresenterThread();

    active_.store(true);
    diag_.presenterAttachCount++;

    printf("[NativePresenter] Attached: %ux%u, owner=0x%p, presenter=0x%p, slots=%u\n",
           surfaceWidth_, surfaceHeight_,
           reinterpret_cast<void*>(ownerHwnd_),
           reinterpret_cast<void*>(presenterWnd_),
           kPresenterSlotCount);

    return true;
}

// ── Detach ──────────────────────────────────────────────────────────────

void NativePresenter::Detach() {
    if (!active_.exchange(false)) return;

    printf("[NativePresenter] Detaching...\n");

    // ── Stop the presenter thread first ──
    StopPresenterThread();

    // ── Destroy persistent slots ──
    DestroyPersistentSlots();

    // ── Destroy D3D11 resources ──
    {
        std::lock_guard<std::mutex> lock(d3dMutex_);
        DestroyD3DResources();
    }

    // ── Destroy window ──
    if (presenterWnd_ && IsWindow(presenterWnd_)) {
        DestroyWindow(presenterWnd_);
    }

    presenterWnd_ = nullptr;
    ownerHwnd_ = nullptr;
    surfaceWidth_ = 0;
    surfaceHeight_ = 0;
    surfaceX_ = 0;
    surfaceY_ = 0;

    diag_.presenterDetachCount++;
    printf("[NativePresenter] Detached\n");
}

// ── Bounds / Visibility ────────────────────────────────────────────────

void NativePresenter::UpdateBounds(int32_t x, int32_t y, uint32_t width, uint32_t height) {
    if (!active_.load() || !presenterWnd_) return;

    surfaceX_ = x;
    surfaceY_ = y;

    if (width == 0) width = 1;
    if (height == 0) height = 1;

    bool sizeChanged = (width != surfaceWidth_ || height != surfaceHeight_);
    surfaceWidth_ = width;
    surfaceHeight_ = height;

    SetWindowPos(presenterWnd_, HWND_TOP,
                 x, y,
                 static_cast<int>(width),
                 static_cast<int>(height),
                 SWP_NOACTIVATE | SWP_SHOWWINDOW);

    if (sizeChanged) {
        std::lock_guard<std::mutex> lock(d3dMutex_);
        ResizeSwapchain(width, height);
        diag_.RecordResize();
        printf("[NativePresenter] Resized to %ux%u at (%d, %d)\n", width, height, x, y);
    }
}

void NativePresenter::SetVisible(bool visible) {
    if (!active_.load() || !presenterWnd_) return;
    visible_ = visible;
    ShowWindow(presenterWnd_, visible ? SW_SHOWNA : SW_HIDE);
}

// ── Frame submission: Present from D3D11 texture ───────────────────────

bool NativePresenter::PresentFrame(ID3D11Texture2D* srcTexture) {
    if (!active_.load() || !srcTexture) {
        return false;
    }

    // Claim an available slot
    uint32_t slotIdx = ClaimAvailableSlot();
    if (slotIdx >= kPresenterSlotCount) {
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    // Copy from source texture to persistent slot
    if (!FillSlotFromD3DTexture(slotIdx, srcTexture)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.presentErrors++;
        return false;
    }

    // Enqueue for presenter thread
    if (!EnqueueSlot(slotIdx)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    return true;
}

// ── Frame submission: Present from CPU buffer (GPU upload) ─────────────

bool NativePresenter::PresentFrameFromCudaBuffer(const void* srcData,
                                                   uint32_t width,
                                                   uint32_t height,
                                                   uint32_t stride) {
    if (!active_.load() || !srcData) {
        return false;
    }

    // Claim an available slot
    uint32_t slotIdx = ClaimAvailableSlot();
    if (slotIdx >= kPresenterSlotCount) {
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    // Upload CPU data into the persistent slot
    if (!FillSlotFromCpuBuffer(slotIdx, srcData, width, height, stride)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.presentErrors++;
        return false;
    }

    // Enqueue for presenter thread
    if (!EnqueueSlot(slotIdx)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    return true;
}

// ── Frame submission: Present from CUDA GPU buffer ─────────────────────

bool NativePresenter::PresentFrameFromCudaGpuBuffer(const void* cudaDevicePtr,
                                                      uint32_t width,
                                                      uint32_t height,
                                                      uint32_t stride) {
    if (!active_.load() || !cudaDevicePtr) {
        return false;
    }

#ifndef SCREENLINK_ENABLE_CUDA_PRESENTER
    // CUDA presenter not compiled in — fall back to CPU upload path
    return PresentFrameFromCudaBuffer(cudaDevicePtr, width, height, stride);
#else
    // Claim an available slot
    uint32_t slotIdx = ClaimAvailableSlot();
    if (slotIdx >= kPresenterSlotCount) {
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    // Copy from CUDA device pointer into persistent slot via CUDA-D3D11 interop
    if (!FillSlotFromCudaGpu(slotIdx, cudaDevicePtr, width, height, stride)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.presentErrors++;
        return false;
    }

    // Enqueue for presenter thread
    if (!EnqueueSlot(slotIdx)) {
        slots_[slotIdx].available.store(true, std::memory_order_release);
        diag_.framesDropped++;
        diag_.queueOverflowDrops++;
        return false;
    }

    return true;
#endif
}

// ── Slot management ─────────────────────────────────────────────────────

uint32_t NativePresenter::ClaimAvailableSlot() {
    // Round-robin: try slots in order starting from producerSlotCounter_.
    // A slot is available when its atomic flag is true.
    uint64_t base = producerSlotCounter_.fetch_add(1, std::memory_order_relaxed);
    for (uint32_t i = 0; i < kPresenterSlotCount; ++i) {
        uint32_t idx = static_cast<uint32_t>((base + i) % kPresenterSlotCount);
        bool expected = true;
        if (slots_[idx].available.compare_exchange_strong(expected, false,
                std::memory_order_acq_rel, std::memory_order_acquire)) {
            return idx;
        }
    }
    return kPresenterSlotCount; // All slots busy
}

bool NativePresenter::FillSlotFromCudaGpu(uint32_t slotIndex,
                                           const void* cudaDevicePtr,
                                           uint32_t width, uint32_t height,
                                           uint32_t stride) {
#ifdef SCREENLINK_ENABLE_CUDA_PRESENTER
    if (slotIndex >= kPresenterSlotCount) return false;
    auto& slot = slots_[slotIndex];
    if (!slot.cudaResource || !slot.texture) return false;

    CUresult cuErr;

    // Map the CUDA graphics resource for write access
    cuErr = cuGraphicsMapResources(1, reinterpret_cast<CUgraphicsResource*>(&slot.cudaResource), nullptr);
    if (cuErr != CUDA_SUCCESS) {
        fprintf(stderr, "[NativePresenter] cuGraphicsMapResources failed: %d\n", static_cast<int>(cuErr));
        return false;
    }

    // Get the mapped array from the subresource
    CUarray mappedArray = nullptr;
    cuErr = cuGraphicsSubResourceGetMappedArray(&mappedArray,
                reinterpret_cast<CUgraphicsResource>(slot.cudaResource), 0, 0);
    if (cuErr != CUDA_SUCCESS || !mappedArray) {
        cuGraphicsUnmapResources(1, reinterpret_cast<CUgraphicsResource*>(&slot.cudaResource), nullptr);
        fprintf(stderr, "[NativePresenter] cuGraphicsSubResourceGetMappedArray failed: %d\n",
                static_cast<int>(cuErr));
        return false;
    }

    // Copy from CUDA device pointer to the mapped D3D11 texture
    CUDA_MEMCPY2D copyDesc = {};
    copyDesc.srcMemoryType = CU_MEMORYTYPE_DEVICE;
    copyDesc.srcDevice = reinterpret_cast<CUdeviceptr>(cudaDevicePtr);
    copyDesc.srcPitch = stride > 0 ? stride : width * 4;

    copyDesc.dstMemoryType = CU_MEMORYTYPE_ARRAY;
    copyDesc.dstArray = mappedArray;
    copyDesc.dstXInBytes = 0;
    copyDesc.dstY = 0;

    copyDesc.WidthInBytes = width * 4;
    copyDesc.Height = height;

    cuErr = cuMemcpy2D(&copyDesc);
    if (cuErr != CUDA_SUCCESS) {
        cuGraphicsUnmapResources(1, reinterpret_cast<CUgraphicsResource*>(&slot.cudaResource), nullptr);
        fprintf(stderr, "[NativePresenter] cuMemcpy2D failed: %d\n", static_cast<int>(cuErr));
        return false;
    }

    // Unmap the resource (D3D can now access the texture)
    cuErr = cuGraphicsUnmapResources(1, reinterpret_cast<CUgraphicsResource*>(&slot.cudaResource), nullptr);
    if (cuErr != CUDA_SUCCESS) {
        fprintf(stderr, "[NativePresenter] cuGraphicsUnmapResources failed: %d\n", static_cast<int>(cuErr));
        return false;
    }

    slot.width = width;
    slot.height = height;
    slot.stride = stride;
    return true;
#else
    (void)slotIndex;
    (void)cudaDevicePtr;
    (void)width;
    (void)height;
    (void)stride;
    return false;
#endif
}

bool NativePresenter::FillSlotFromD3DTexture(uint32_t slotIndex, ID3D11Texture2D* src) {
    if (slotIndex >= kPresenterSlotCount || !src) return false;
    auto& slot = slots_[slotIndex];
    if (!slot.texture) return false;

    std::lock_guard<std::mutex> lock(d3dMutex_);
    ComPtr<ID3D11DeviceContext> context;
    d3dDevice_->GetImmediateContext(&context);
    if (!context) return false;

    D3D11_TEXTURE2D_DESC srcDesc;
    src->GetDesc(&srcDesc);

    // Copy from source to persistent slot texture
    context->CopyResource(slot.texture.Get(), src);

    slot.width = srcDesc.Width;
    slot.height = srcDesc.Height;
    slot.stride = srcDesc.Width * 4;
    return true;
}

bool NativePresenter::FillSlotFromCpuBuffer(uint32_t slotIndex,
                                              const void* srcData,
                                              uint32_t width, uint32_t height,
                                              uint32_t stride) {
    if (slotIndex >= kPresenterSlotCount || !srcData) return false;
    auto& slot = slots_[slotIndex];
    if (!slot.texture) return false;

    std::lock_guard<std::mutex> lock(d3dMutex_);
    ComPtr<ID3D11DeviceContext> context;
    d3dDevice_->GetImmediateContext(&context);
    if (!context) return false;

    UINT srcRowPitch = stride > 0 ? stride : width * 4;
    context->UpdateSubresource(slot.texture.Get(), 0, nullptr, srcData, srcRowPitch, 0);

    slot.width = width;
    slot.height = height;
    slot.stride = srcRowPitch;
    return true;
}

bool NativePresenter::EnqueueSlot(uint32_t slotIndex) {
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        if (!frameQueue_.TryPush(slotIndex)) {
            return false;
        }
    }

    // Update diagnostics
    uint32_t qd = frameQueue_.Size();
    diag_.queueDepth.store(qd, std::memory_order_relaxed);
    if (qd > diag_.queueMaxDepth.load(std::memory_order_relaxed)) {
        diag_.queueMaxDepth.store(qd, std::memory_order_relaxed);
    }
    diag_.queueEnqueued++;

    // Wake the presenter thread
    queueCv_.notify_one();
    return true;
}

// ── Presenter thread ────────────────────────────────────────────────────

void NativePresenter::StartPresenterThread() {
    presenterThreadStop_ = false;
    presenterThread_ = std::thread(&NativePresenter::PresenterThreadProc, this);
}

void NativePresenter::StopPresenterThread() {
    {
        std::lock_guard<std::mutex> lock(queueMutex_);
        presenterThreadStop_ = true;
    }
    queueCv_.notify_one();

    if (presenterThread_.joinable()) {
        presenterThread_.join();
    }
}

void NativePresenter::PresenterThreadProc() {
    printf("[NativePresenter] Presenter thread started\n");

    // Set thread name for debugging
    typedef HRESULT(WINAPI *SetThreadDescriptionFunc)(HANDLE, PCWSTR);
    auto setThreadDesc = reinterpret_cast<SetThreadDescriptionFunc>(
        GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "SetThreadDescription"));
    if (setThreadDesc) {
        setThreadDesc(GetCurrentThread(), L"ScreenLink Presenter");
    }

    while (true) {
        uint32_t slotIndex = UINT32_MAX;

        // Wait for work (or shutdown).  The predicate checks queue non-empty
        // WITHOUT side effects — TryPop happens exclusively in the loop body.
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            queueCv_.wait(lock, [this]() {
                return presenterThreadStop_ || frameQueue_.Size() > 0;
            });

            if (presenterThreadStop_) {
                break;
            }

            // Pop the next available frame; spurious wake → keep waiting
            if (!frameQueue_.TryPop(slotIndex)) {
                continue;
            }
        }

        if (slotIndex >= kPresenterSlotCount) {
            continue;
        }

        auto& slot = slots_[slotIndex];

        // ── Present the slot ──
        auto t_start = std::chrono::high_resolution_clock::now();

        bool presentOk = false;
        {
            std::lock_guard<std::mutex> lock(d3dMutex_);

            if (swapChain_ && backBuffer_) {
                ComPtr<ID3D11DeviceContext> context;
                d3dDevice_->GetImmediateContext(&context);

                if (context && slot.texture) {
                    // Copy slot texture to backbuffer
                    D3D11_BOX srcBox = {};
                    srcBox.left = 0;
                    srcBox.top = 0;
                    srcBox.right = std::min(slot.width, surfaceWidth_);
                    srcBox.bottom = std::min(slot.height, surfaceHeight_);
                    srcBox.front = 0;
                    srcBox.back = 1;

                    context->CopySubresourceRegion(backBuffer_.Get(), 0, 0, 0, 0,
                                                    slot.texture.Get(), 0, &srcBox);

                    // Present with VSync (waits on presenter thread, not processing thread)
                    HRESULT hr = swapChain_->Present(1, 0);
                    if (SUCCEEDED(hr)) {
                        presentOk = true;
                    } else {
                        fprintf(stderr, "[NativePresenter] Present failed: 0x%08lX\n", hr);
                        diag_.presentErrors++;
                        if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
                            fprintf(stderr, "[NativePresenter] Device lost\n");
                            // Recovery is handled on next Attach
                        }
                    }
                }
            }
        }

        auto t_end = std::chrono::high_resolution_clock::now();
        uint64_t elapsedUs = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(t_end - t_start).count());
        diag_.RecordPresent(elapsedUs, presentOk);
        diag_.queueDequeued++;

        // Release slot back to the pool
        slot.available.store(true, std::memory_order_release);
    }

    // Drain any remaining frames
    uint32_t remaining;
    while (frameQueue_.TryPop(remaining)) {
        if (remaining < kPresenterSlotCount) {
            slots_[remaining].available.store(true, std::memory_order_release);
        }
    }

    printf("[NativePresenter] Presenter thread stopped\n");
}

// ── Persistent slot creation / destruction ─────────────────────────────

bool NativePresenter::CreatePersistentSlots(uint32_t width, uint32_t height, uint32_t stride) {
    DestroyPersistentSlots();

    if (!d3dDevice_) return false;

    for (uint32_t i = 0; i < kPresenterSlotCount; ++i) {
        auto& slot = slots_[i];

        D3D11_TEXTURE2D_DESC desc = {};
        desc.Width = width;
        desc.Height = height;
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        desc.SampleDesc.Count = 1;
        desc.SampleDesc.Quality = 0;
        desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        desc.CPUAccessFlags = 0;
        desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED; // Required for CUDA interop

        HRESULT hr = d3dDevice_->CreateTexture2D(&desc, nullptr, &slot.texture);
        if (FAILED(hr)) {
            fprintf(stderr, "[NativePresenter] CreateTexture2D (slot %u) failed: 0x%08lX\n", i, hr);
            DestroyPersistentSlots();
            return false;
        }

        slot.width = width;
        slot.height = height;
        slot.stride = stride > 0 ? stride : width * 4;
        slot.available.store(true, std::memory_order_release);

#ifdef SCREENLINK_ENABLE_CUDA_PRESENTER
        // Register the D3D11 texture with CUDA (one-time, persistent)
        CUresult cuErr = cuGraphicsD3D11RegisterResource(
            reinterpret_cast<CUgraphicsResource*>(&slot.cudaResource),
            slot.texture.Get(),
            CU_GRAPHICS_REGISTER_FLAGS_WRITE_DISCARD);

        if (cuErr != CUDA_SUCCESS) {
            fprintf(stderr, "[NativePresenter] cuGraphicsD3D11RegisterResource (slot %u) failed: %d\n",
                    i, static_cast<int>(cuErr));
            slot.cudaResource = nullptr;
            DestroyPersistentSlots();
            return false;
        }

        printf("[NativePresenter] Slot %u: D3D11 texture + CUDA resource registered\n", i);
#endif
    }

    // Reset producer counter for fresh round-robin allocation
    producerSlotCounter_.store(0, std::memory_order_relaxed);

    printf("[NativePresenter] %u persistent slots created: %ux%u, stride=%u\n",
           kPresenterSlotCount, width, height, stride);
    return true;
}

void NativePresenter::DestroyPersistentSlots() {
    for (uint32_t i = 0; i < kPresenterSlotCount; ++i) {
        auto& slot = slots_[i];

#ifdef SCREENLINK_ENABLE_CUDA_PRESENTER
        if (slot.cudaResource) {
            CUresult cuErr = cuGraphicsUnregisterResource(
                reinterpret_cast<CUgraphicsResource>(slot.cudaResource));
            if (cuErr != CUDA_SUCCESS) {
                fprintf(stderr, "[NativePresenter] cuGraphicsUnregisterResource (slot %u) failed: %d\n",
                        i, static_cast<int>(cuErr));
            }
            slot.cudaResource = nullptr;
        }
#endif

        slot.texture.Reset();
        slot.width = 0;
        slot.height = 0;
        slot.stride = 0;
        slot.available.store(true, std::memory_order_release);
    }

    producerSlotCounter_.store(0, std::memory_order_relaxed);
}

// ── D3D11 resource management ──────────────────────────────────────────

bool NativePresenter::CreateD3DResources(HWND ownerHwnd, uint32_t width, uint32_t height) {
    // d3dMutex_ should already be held by caller
    DestroyD3DResources();

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
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
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

    d3dDevice_ = device;
    d3dContext_ = context;

    printf("[NativePresenter] D3D11 device created: feature level %d.%d\n",
           (selectedLevel >> 12) & 0xF, (selectedLevel >> 8) & 0xF);

    return CreateSwapchain(ownerHwnd, width, height);
}

void NativePresenter::DestroyD3DResources() {
    backBuffer_.Reset();
    swapChain_.Reset();

    if (d3dContext_) {
        d3dContext_->ClearState();
        d3dContext_->Flush();
        d3dContext_.Reset();
    }
    d3dDevice_.Reset();
}

void NativePresenter::ResetBackbuffer() {
    backBuffer_.Reset();
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
    desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    desc.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

    HWND targetWnd = presenterWnd_ ? presenterWnd_ : ownerHwnd;

    hr = factory->CreateSwapChainForHwnd(
        d3dDevice_.Get(),
        targetWnd,
        &desc,
        nullptr,
        nullptr,
        &swapChain_
    );

    if (FAILED(hr)) {
        desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL;
        hr = factory->CreateSwapChainForHwnd(
            d3dDevice_.Get(),
            targetWnd,
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

    hr = swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer_));
    if (FAILED(hr)) {
        fprintf(stderr, "[NativePresenter] GetBuffer (backbuffer) failed: 0x%08lX\n", hr);
        return false;
    }

    ComPtr<IDXGIFactory> factoryBase;
    factory.As(&factoryBase);
    if (factoryBase) {
        factoryBase->MakeWindowAssociation(targetWnd, DXGI_MWA_NO_ALT_ENTER);
    }

    printf("[NativePresenter] Swapchain created: %ux%u\n", width, height);
    return true;
}

bool NativePresenter::ResizeSwapchain(uint32_t width, uint32_t height) {
    if (!swapChain_) return false;

    backBuffer_.Reset();

    HRESULT hr = swapChain_->ResizeBuffers(
        2,
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
