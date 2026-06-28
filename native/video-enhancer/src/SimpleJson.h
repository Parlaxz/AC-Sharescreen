#pragma once
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>
#include <cstdint>

namespace screenlink::video {

struct JsonObject;

/// Value types supported by our minimal JSON.
/// Now supports nested objects via shared_ptr<JsonObject>.
using JsonValue = std::variant<std::nullptr_t, bool, double, std::string, std::shared_ptr<JsonObject>>;

/// A JSON object: map of string keys to values.
struct JsonObject {
    std::unordered_map<std::string, JsonValue> values;

    // Forwarding accessors for backward compatibility
    JsonValue& operator[](const std::string& key) { return values[key]; }
    const JsonValue& operator[](const std::string& key) const { return values.at(key); }

    auto begin() { return values.begin(); }
    auto end() { return values.end(); }
    auto begin() const { return values.begin(); }
    auto end() const { return values.end(); }

    auto find(const std::string& key) { return values.find(key); }
    auto find(const std::string& key) const { return values.find(key); }

    bool empty() const { return values.empty(); }
    size_t size() const { return values.size(); }
};

/// Parse a single JSON object from a string.
/// Throws std::runtime_error on parse failure.
JsonObject ParseJson(std::string_view json);

/// Serialize a JSON object to a compact string.
std::string SerializeJson(const JsonObject& obj);

// ─── Field access helpers ──────────────────────────────────────────────

/// Get a string value, or if the value is a nested object, return it serialized as JSON.
/// Returns std::nullopt if the key is not found or the value is null/bool/number.
std::optional<std::string> GetString(const JsonObject& obj, const std::string& key);
double GetNumber(const JsonObject& obj, const std::string& key, double fallback = 0.0);
bool GetBool(const JsonObject& obj, const std::string& key, bool fallback = false);

} // namespace screenlink::video
