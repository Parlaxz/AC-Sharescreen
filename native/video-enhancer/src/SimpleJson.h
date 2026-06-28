#pragma once
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>
#include <cstdint>

namespace screenlink::video {

/// Value types supported by our minimal JSON.
using JsonValue = std::variant<std::nullptr_t, bool, double, std::string>;

/// A JSON object: map of string keys to values.
/// Nested objects/arrays are NOT supported (not needed for the protocol).
using JsonObject = std::unordered_map<std::string, JsonValue>;

/// Parse a single JSON object from a string.
/// Throws std::runtime_error on parse failure.
JsonObject ParseJson(std::string_view json);

/// Serialize a JSON object to a compact string.
std::string SerializeJson(const JsonObject& obj);

// ─── Field access helpers ──────────────────────────────────────────────

const std::string* GetString(const JsonObject& obj, const std::string& key);
double GetNumber(const JsonObject& obj, const std::string& key, double fallback = 0.0);
bool GetBool(const JsonObject& obj, const std::string& key, bool fallback = false);

} // namespace screenlink::video
