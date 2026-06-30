// ─── video-frame-ring native addon ───────────────────────────────────────────
// N-API (Node-API) entry point for Win32 named file-mapping ring buffer.
//
// The addon exposes a FrameRing class with the following methods:
//   create(slotPayloadSize?: number) → { name, sessionGuid }
//   open(mappingName, sessionGuid) → void
//   close() → void
//   getSlotBuffer(slotIndex) → Buffer | null
//   copyToSlot(slotIndex, data) → number
//   readOutputSlot() → Buffer | null
//   setFrameReady(slotIndex) → void
//   validateAllSlots() → boolean
//
// Exported as a Node-API addon, loaded via require() in the Electron main process.

#include <algorithm>
#include <cstring>
#include <memory>
#include <new>
#include <string>
#include <vector>

// node-addon-api headers have some C4127 (constant conditional) warnings.
// Suppress these since they come from the library, not our code.
#pragma warning(push)
#pragma warning(disable: 4127 4244)
#include <napi.h>  // node-addon-api
#pragma warning(pop)

#include "FrameRing.h"
#include "SlotLayout.h"

namespace slfr = screenlink::framering;

// ─── Helper: translate error code to JS Error ────────────────────────────────

static Napi::Error MakeFrameRingError(Napi::Env env, slfr::FrameRingErrorCode code) {
    std::string msg(slfr::FrameRingErrorCodeToString(code));
    auto err = Napi::Error::New(env, msg);
    err.Set("code", Napi::Number::New(env, static_cast<uint32_t>(code)));
    return err;
}

static void ThrowIfError(Napi::Env env, slfr::FrameRingErrorCode code) {
    if (code != slfr::FrameRingErrorCode::None) {
        throw MakeFrameRingError(env, code);
    }
}

// ─── FrameRing Wrapper ───────────────────────────────────────────────────────

class FrameRingWrap : public Napi::ObjectWrap<FrameRingWrap> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::FunctionReference constructor;

    FrameRingWrap(const Napi::CallbackInfo& info);
    ~FrameRingWrap() override = default;

private:
    slfr::FrameRing m_ring;

    // JS-callable methods
    Napi::Value Create(const Napi::CallbackInfo& info);
    Napi::Value Open(const Napi::CallbackInfo& info);
    void Close(const Napi::CallbackInfo& info);
    Napi::Value GetSlotBuffer(const Napi::CallbackInfo& info);
    Napi::Value CopyToSlot(const Napi::CallbackInfo& info);
    Napi::Value ReadOutputSlot(const Napi::CallbackInfo& info);
    void SetFrameReady(const Napi::CallbackInfo& info);
    Napi::Value ValidateAllSlots(const Napi::CallbackInfo& info);
    Napi::Value IsValid(const Napi::CallbackInfo& info);
    Napi::Value GetName(const Napi::CallbackInfo& info);
    Napi::Value GetSlotCount(const Napi::CallbackInfo& info);
    Napi::Value GetSlotPayloadSize(const Napi::CallbackInfo& info);
    Napi::Value GetSessionGuid(const Napi::CallbackInfo& info);
};

Napi::FunctionReference FrameRingWrap::constructor;

Napi::Object FrameRingWrap::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "FrameRing", {
        InstanceMethod("create",            &FrameRingWrap::Create),
        InstanceMethod("open",              &FrameRingWrap::Open),
        InstanceMethod("close",             &FrameRingWrap::Close),
        InstanceMethod("getSlotBuffer",     &FrameRingWrap::GetSlotBuffer),
        InstanceMethod("copyToSlot",        &FrameRingWrap::CopyToSlot),
        InstanceMethod("readOutputSlot",    &FrameRingWrap::ReadOutputSlot),
        InstanceMethod("setFrameReady",     &FrameRingWrap::SetFrameReady),
        InstanceMethod("validateAllSlots",  &FrameRingWrap::ValidateAllSlots),
        InstanceMethod("isValid",           &FrameRingWrap::IsValid),
        InstanceAccessor("name",            &FrameRingWrap::GetName, nullptr),
        InstanceAccessor("slotCount",       &FrameRingWrap::GetSlotCount, nullptr),
        InstanceAccessor("slotPayloadSize", &FrameRingWrap::GetSlotPayloadSize, nullptr),
        InstanceAccessor("sessionGuid",     &FrameRingWrap::GetSessionGuid, nullptr),
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    exports.Set("FrameRing", func);
    return exports;
}

FrameRingWrap::FrameRingWrap(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<FrameRingWrap>(info)
{}

// ─── Methods ──────────────────────────────────────────────────────────────────

Napi::Value FrameRingWrap::Create(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    size_t slotPayloadSize = slfr::kDefaultSlotPayloadSize;

    if (info.Length() >= 1 && info[0].IsNumber()) {
        double val = info[0].As<Napi::Number>().DoubleValue();
        if (val <= 0 || val > 1024 * 1024 * 1024) { // max 1 GiB per slot
            throw Napi::RangeError::New(env, "slotPayloadSize must be in (0, 1 GiB]");
        }
        slotPayloadSize = static_cast<size_t>(val);
    }

    // Generate a random mapping name (hex-encoded session GUID)
    uint8_t guid[slfr::kSessionGuidBytes];
    slfr::FrameRingErrorCode err = slfr::FrameRing::GenerateSessionGuid(guid);
    ThrowIfError(env, err);

    std::string name = slfr::FrameRing::SessionGuidToString(guid);

    err = m_ring.Create(name, slotPayloadSize);
    ThrowIfError(env, err);

    Napi::Object result = Napi::Object::New(env);
    result.Set("name", Napi::String::New(env, m_ring.Name()));
    result.Set("sessionGuid", Napi::String::New(env, slfr::FrameRing::SessionGuidToString(m_ring.SessionGuid())));
    result.Set("slotCount", Napi::Number::New(env, m_ring.SlotCount()));
    result.Set("slotPayloadSize", Napi::Number::New(env, static_cast<double>(m_ring.SlotPayloadSize())));
    return result;
}

Napi::Value FrameRingWrap::Open(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        throw Napi::TypeError::New(env, "Expected (mappingName: string, sessionGuid: string)");
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    std::string guidHex = info[1].As<Napi::String>().Utf8Value();

    uint8_t guid[slfr::kSessionGuidBytes];
    if (!slfr::FrameRing::StringToSessionGuid(guidHex, guid)) {
        throw Napi::Error::New(env, "Invalid session GUID hex string");
    }

    slfr::FrameRingErrorCode err = m_ring.Open(name, guid);
    ThrowIfError(env, err);

    return env.Undefined();
}

void FrameRingWrap::Close(const Napi::CallbackInfo& /*info*/) {
    m_ring.Close();
}

Napi::Value FrameRingWrap::GetSlotBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        throw Napi::TypeError::New(env, "Expected slotIndex: number");
    }

    uint32_t slotIndex = info[0].As<Napi::Number>().Uint32Value();
    if (slotIndex >= slfr::kSlotCount) {
        throw Napi::RangeError::New(env, "slotIndex out of range (0-2)");
    }

    // First validate the slot
    if (!m_ring.IsValid()) {
        throw MakeFrameRingError(env, slfr::FrameRingErrorCode::NotInitialized);
    }

    const slfr::SlotHeader* hdr = m_ring.GetSlotHeader(slotIndex);
    uint8_t* payload = m_ring.GetSlotPayload(slotIndex);

    if (!hdr || !payload) {
        return env.Null();
    }

    size_t bufSize = static_cast<size_t>(hdr->payloadSize);

    // Create a N-API Buffer that shares the mapped memory.
    // This Buffer is NOT a copy — it's a view into the file-mapping.
    // The lifetime of the underlying memory is tied to the FrameRingWrap instance.
    auto buf = Napi::Buffer<uint8_t>::New(env, payload, bufSize,
        [](Napi::Env /*env*/, void* /*data*/) {
            // No-op finalizer: the mapped memory is owned by the FrameRing object.
            // The user must keep the FrameRingWrap alive while using the buffer.
        });

    return buf;
}

Napi::Value FrameRingWrap::CopyToSlot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber()) {
        throw Napi::TypeError::New(env, "Expected (slotIndex: number, data: Buffer | TypedArray)");
    }

    uint32_t slotIndex = info[0].As<Napi::Number>().Uint32Value();
    if (slotIndex >= slfr::kSlotCount) {
        throw Napi::RangeError::New(env, "slotIndex out of range (0-2)");
    }

    if (!m_ring.IsValid()) {
        throw MakeFrameRingError(env, slfr::FrameRingErrorCode::NotInitialized);
    }

    // Accept Buffer, TypedArray, or DataView
    Napi::Value dataVal = info[1];
    uint8_t* dataPtr = nullptr;
    size_t dataSize = 0;

    if (dataVal.IsBuffer()) {
        auto buf = dataVal.As<Napi::Buffer<uint8_t>>();
        dataPtr = buf.Data();
        dataSize = buf.Length();
    } else if (dataVal.IsTypedArray()) {
        auto arr = dataVal.As<Napi::TypedArray>();
        dataPtr = static_cast<uint8_t*>(arr.ArrayBuffer().Data()) + arr.ByteOffset();
        dataSize = arr.ByteLength();
    } else if (dataVal.IsDataView()) {
        auto dv = dataVal.As<Napi::DataView>();
        dataPtr = static_cast<uint8_t*>(dv.ArrayBuffer().Data()) + dv.ByteOffset();
        dataSize = dv.ByteLength();
    } else {
        throw Napi::TypeError::New(env, "Expected Buffer, TypedArray, or DataView");
    }

    size_t written = m_ring.WriteSlot(slotIndex, dataPtr, dataSize);
    return Napi::Number::New(env, static_cast<double>(written));
}

Napi::Value FrameRingWrap::ReadOutputSlot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!m_ring.IsValid()) {
        throw MakeFrameRingError(env, slfr::FrameRingErrorCode::NotInitialized);
    }

    const slfr::SlotHeader* hdr = m_ring.GetSlotHeader(slfr::kSlotOutput);
    uint8_t* payload = m_ring.GetSlotPayload(slfr::kSlotOutput);

    if (!hdr || !payload || hdr->dataSize == 0) {
        return env.Null();
    }

    // Validate session before reading
    if (!m_ring.ValidateSlotSession(slfr::kSlotOutput)) {
        throw MakeFrameRingError(env, slfr::FrameRingErrorCode::SessionMismatch);
    }

    size_t dataSize = (std::min)(static_cast<size_t>(hdr->dataSize),
                                  static_cast<size_t>(hdr->payloadSize));

    // Copy the output data into a new Buffer (safe copy, not a view)
    auto buf = Napi::Buffer<uint8_t>::Copy(env, payload, dataSize);
    return buf;
}

void FrameRingWrap::SetFrameReady(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        throw Napi::TypeError::New(env, "Expected slotIndex: number");
    }

    uint32_t slotIndex = info[0].As<Napi::Number>().Uint32Value();
    if (slotIndex >= slfr::kSlotCount) {
        throw Napi::RangeError::New(env, "slotIndex out of range (0-2)");
    }

    if (!m_ring.IsValid()) {
        throw MakeFrameRingError(env, slfr::FrameRingErrorCode::NotInitialized);
    }

    m_ring.SetFrameReady(slotIndex);
}

Napi::Value FrameRingWrap::ValidateAllSlots(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!m_ring.IsValid()) {
        return Napi::Boolean::New(env, false);
    }
    return Napi::Boolean::New(env, m_ring.ValidateAllSlots());
}

Napi::Value FrameRingWrap::IsValid(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), m_ring.IsValid());
}

Napi::Value FrameRingWrap::GetName(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(), m_ring.Name());
}

Napi::Value FrameRingWrap::GetSlotCount(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), m_ring.SlotCount());
}

Napi::Value FrameRingWrap::GetSlotPayloadSize(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(m_ring.SlotPayloadSize()));
}

Napi::Value FrameRingWrap::GetSessionGuid(const Napi::CallbackInfo& info) {
    if (!m_ring.IsValid()) {
        return info.Env().Null();
    }
    return Napi::String::New(info.Env(), slfr::FrameRing::SessionGuidToString(m_ring.SessionGuid()));
}

// ─── Module initialization ────────────────────────────────────────────────────

static Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    return FrameRingWrap::Init(env, exports);
}

NODE_API_MODULE(video_frame_ring, InitModule)
