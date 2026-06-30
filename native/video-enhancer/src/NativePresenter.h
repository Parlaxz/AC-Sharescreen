#pragma once

#include <cstdint>
#include <atomic>
#include <string>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace screenlink::video {

// ── Compile-time constants ─────────────────────────────────────────────

/// Number of persistent presenter frame slots for CUDA-D3D11 interop.
/// Matches the triple-buffer convention used elsewhere in the pipeline.
constexpr uint32_t kPresenterSlotCount = 3;

// ── Diagnostics ────────────────────────────────────────────────────────

/// Diagnostics counters specific to the native presenter path.
struct PresenterDiagnostics {
    std::atomic<uint64_t> framesPresented{0};
    std::atomic<uint64_t> framesDropped{0};
    std::atomic<uint64_t> presentErrors{0};
    std::atomic<uint64_t> lastPresentUs{0};
    std::atomic<uint64_t> maxPresentUs{0};
    std::atomic<uint64_t> totalPresentUs{0};

    std::atomic<uint32_t> presenterResizes{0};
    std::atomic<uint32_t> presenterAttachCount{0};
    std::atomic<uint32_t> presenterDetachCount{0};

    // Queue/presenter-thread diagnostics (Slice 3)
    std::atomic<uint64_t> queueEnqueued{0};
    std::atomic<uint64_t> queueDequeued{0};
    std::atomic<uint64_t> queueOverflowDrops{0};
    std::atomic<uint64_t> staleGenerationDrops{0};
    std::atomic<uint32_t> queueDepth{0};
    std::atomic<uint32_t> queueMaxDepth{0};

    void RecordPresent(uint64_t elapsedUs, bool success);
    void Reset();
    void RecordResize() { presenterResizes++; }
};

/// Snapshot of presenter diagnostics.
struct PresenterSnapshot {
    uint64_t framesPresented;
    uint64_t framesDropped;
    uint64_t presentErrors;
    uint64_t lastPresentUs;
    uint64_t maxPresentUs;
    uint64_t avgPresentUs;
    uint32_t presenterResizes;
    uint32_t presenterAttachCount;
    uint32_t presenterDetachCount;

    // Queue diagnostics (Slice 3)
    uint64_t queueEnqueued;
    uint64_t queueDequeued;
    uint64_t queueOverflowDrops;
    uint64_t staleGenerationDrops;
    uint32_t queueDepth;
    uint32_t queueMaxDepth;

    bool active;
};

// ── Persistent presenter slot ──────────────────────────────────────────

/// A single persistent frame slot that holds GPU-resident pixel data
/// for CUDA-D3D11 interop. Created during Attach; destroyed during Detach.
/// No per-frame allocation or CUDA register/unregister.
struct PresenterSlot {
    ComPtr<ID3D11Texture2D> texture;       // Persistent D3D11 texture (shared, for CUDA interop)
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t stride = 0;

    // The slot is "owned" by the producer when this is false;
    // ownership transfers to the consumer (presenter thread) on enqueue.
    std::atomic<bool> available{true};

#ifdef SCREENLINK_ENABLE_CUDA_PRESENTER
    void* cudaResource = nullptr;          // cudaGraphicsResource_t (opaque, from cudaD3D11.h)
#endif
};

// ── Bounded SPSC queue for frame handoff ───────────────────────────────
//
// Single-producer (processing thread), single-consumer (presenter thread).
// Fixed-size ring buffer of slot indices.  When full, the producer drops
// the incoming frame (no allocation, no CUDA copy wasted).

class PresenterQueue {
public:
    explicit PresenterQueue(uint32_t capacity);

    /// Try to push a slot index. Returns false if queue is full (caller should drop frame).
    bool TryPush(uint32_t slotIndex);

    /// Try to pop a slot index. Returns false if queue is empty.
    bool TryPop(uint32_t& slotIndex);

    /// Current number of entries in the queue.
    uint32_t Size() const;

    /// Maximum capacity.
    uint32_t Capacity() const { return capacity_; }

private:
    const uint32_t capacity_;
    std::atomic<uint64_t> head_{0};
    std::atomic<uint64_t> tail_{0};
    std::unique_ptr<uint32_t[]> slots_;
};

// ── NativePresenter ────────────────────────────────────────────────────

/// Manages a D3D11 swapchain presenter window for GPU-resident output display.
///
/// The presenter creates a child window of the owner HWND, creates a D3D11
/// device and swapchain, and presents processed frames directly from GPU memory
/// with no CPU roundtrip.
///
/// SLICE 3: Presentation is decoupled to a dedicated presenter thread with a
/// bounded queue.  Frame submission (EnqueueFrame*) is non-blocking; the
/// actual swapchain Present(1,0) runs on the presenter thread.
///
/// Persistent CUDA-D3D11 interop resources are allocated once during Attach
/// and released during Detach — no per-frame register/unregister.
class NativePresenter {
public:
    NativePresenter();
    ~NativePresenter();

    NativePresenter(const NativePresenter&) = delete;
    NativePresenter& operator=(const NativePresenter&) = delete;

    // ── Lifecycle ────────────────────────────────────────────────────────

    /// Attach to the given owner HWND.  Creates D3D11 device, swapchain,
    /// presenter child window, persistent frame slots, and starts the
    /// presenter thread.  Returns true on success.
    bool Attach(HWND ownerHwnd, uint32_t initialWidth, uint32_t initialHeight);

    /// Detach from the owner HWND.  Stops the presenter thread, drains the
    /// queue, destroys persistent slots, swapchain, D3D device, and window.
    /// Idempotent.
    void Detach();

    // ── Window management ────────────────────────────────────────────────

    /// Update presenter surface bounds (position and size relative to owner).
    void UpdateBounds(int32_t x, int32_t y, uint32_t width, uint32_t height);

    /// Show or hide the presenter window.
    void SetVisible(bool visible);

    // ── Frame submission (non-blocking enqueue) ──────────────────────────

    /// Present a GPU-resident frame from an external D3D11 texture.
    /// Copies into a persistent slot and enqueues for the presenter thread.
    /// Returns true if the frame was accepted (queued), false if dropped
    /// (e.g. queue full or presenter inactive).
    bool PresentFrame(ID3D11Texture2D* srcTexture);

    /// Present from raw RGBA8 pixel data via GPU upload (CPU→GPU copy into
    /// a persistent staging slot). Non-blocking enqueue.
    bool PresentFrameFromCudaBuffer(const void* srcData, uint32_t width,
                                     uint32_t height, uint32_t stride);

    /// Present from a CUDA device pointer using CUDA-D3D11 interop.
    /// Copies into a persistent registered slot and enqueues.
    /// No per-frame register/unregister.  Returns true if queued.
    bool PresentFrameFromCudaGpuBuffer(const void* cudaDevicePtr,
                                        uint32_t width, uint32_t height,
                                        uint32_t stride);

    // ── Accessors ────────────────────────────────────────────────────────

    bool IsActive() const { return active_.load(); }
    HWND GetPresenterWindow() const { return presenterWnd_; }
    uint32_t SurfaceWidth() const { return surfaceWidth_; }
    uint32_t SurfaceHeight() const { return surfaceHeight_; }

    ID3D11Device* D3DDevice() const { return d3dDevice_.Get(); }
    ID3D11DeviceContext* D3DContext() const { return d3dContext_.Get(); }

    PresenterDiagnostics& Diagnostics() { return diag_; }
    PresenterSnapshot GetSnapshot() const;

private:
    // ── D3D11 / swapchain management ─────────────────────────────────────
    bool CreateD3DResources(HWND ownerHwnd, uint32_t width, uint32_t height);
    void DestroyD3DResources();
    bool CreateSwapchain(HWND ownerHwnd, uint32_t width, uint32_t height);
    bool ResizeSwapchain(uint32_t width, uint32_t height);
    void ResetBackbuffer();

    // ── Persistent slot management ───────────────────────────────────────
    bool CreatePersistentSlots(uint32_t width, uint32_t height, uint32_t stride);
    void DestroyPersistentSlots();

    /// Find an available persistent slot and claim it.
    /// Returns kPresenterSlotCount if none available.
    uint32_t ClaimAvailableSlot();

    /// Get the next slot index that the producer should fill (round-robin).
    uint32_t NextProducerSlot();

    /// Copy source data into a claimed persistent slot (CUDA path).
    /// Must be called after ClaimAvailableSlot.
    bool FillSlotFromCudaGpu(uint32_t slotIndex, const void* cudaDevicePtr,
                              uint32_t width, uint32_t height, uint32_t stride);

    /// Copy from a D3D11 texture into a claimed persistent slot.
    bool FillSlotFromD3DTexture(uint32_t slotIndex, ID3D11Texture2D* src);

    /// Upload CPU data into a claimed persistent slot.
    bool FillSlotFromCpuBuffer(uint32_t slotIndex, const void* srcData,
                                uint32_t width, uint32_t height, uint32_t stride);

    /// Enqueue a filled slot for the presenter thread.
    bool EnqueueSlot(uint32_t slotIndex);

    // ── Presenter thread ─────────────────────────────────────────────────
    void StartPresenterThread();
    void StopPresenterThread();
    void PresenterThreadProc();

    // ── Window state ─────────────────────────────────────────────────────
    HWND ownerHwnd_ = nullptr;
    HWND presenterWnd_ = nullptr;
    uint32_t surfaceWidth_ = 0;
    uint32_t surfaceHeight_ = 0;
    int32_t surfaceX_ = 0;
    int32_t surfaceY_ = 0;
    bool visible_ = true;
    std::atomic<bool> active_{false};

    // ── D3D11 resources ──────────────────────────────────────────────────
    ComPtr<ID3D11Device> d3dDevice_;
    ComPtr<ID3D11DeviceContext> d3dContext_;
    ComPtr<IDXGISwapChain1> swapChain_;
    ComPtr<ID3D11Texture2D> backBuffer_;
    std::mutex d3dMutex_;    // Serializes D3D11 device context + swapchain access

    // ── Persistent slots ─────────────────────────────────────────────────
    PresenterSlot slots_[kPresenterSlotCount];
    std::atomic<uint64_t> producerSlotCounter_{0};  // Round-robin producer slot selection

    // ── Frame queue (handoff from processing → presenter thread) ─────────
    PresenterQueue frameQueue_{kPresenterSlotCount};

    // ── Presenter thread ─────────────────────────────────────────────────
    std::thread presenterThread_;
    std::mutex queueMutex_;
    std::condition_variable queueCv_;
    bool presenterThreadStop_ = false;

    // ── Diagnostics ──────────────────────────────────────────────────────
    PresenterDiagnostics diag_;

    // ── Window class ─────────────────────────────────────────────────────
    static bool s_windowClassRegistered;
    static const wchar_t* kWindowClassName;

    static LRESULT CALLBACK PresenterWndProc(HWND hwnd, UINT msg,
                                              WPARAM wParam, LPARAM lParam);
};

/// Get global presenter diagnostics counters.
PresenterDiagnostics& GetPresenterDiagnostics();

} // namespace screenlink::video
