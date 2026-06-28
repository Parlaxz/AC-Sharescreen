#include "SimpleJson.h"
#include <cctype>
#include <stdexcept>
#include <sstream>

namespace screenlink::video {

// ─── Internal: Lexer helpers ──────────────────────────────────────────

static std::string_view TrimWhitespace(std::string_view s) {
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t' || s.front() == '\n' || s.front() == '\r'))
        s.remove_prefix(1);
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\n' || s.back() == '\r'))
        s.remove_suffix(1);
    return s;
}

static std::string ParseString(std::string_view& input) {
    if (input.empty() || input.front() != '"')
        throw std::runtime_error("Expected '\"' at start of string");
    input.remove_prefix(1); // skip opening quote

    std::string result;
    while (!input.empty()) {
        char c = input.front();
        input.remove_prefix(1);
        if (c == '"') break;
        if (c == '\\') {
            if (input.empty()) throw std::runtime_error("Unexpected end in string escape");
            char esc = input.front();
            input.remove_prefix(1);
            switch (esc) {
                case '"': result += '"'; break;
                case '\\': result += '\\'; break;
                case '/': result += '/'; break;
                case 'n': result += '\n'; break;
                case 'r': result += '\r'; break;
                case 't': result += '\t'; break;
                default: result += esc; break;
            }
        } else {
            result += c;
        }
    }
    return result;
}

static JsonValue ParseValue(std::string_view& input);

static double ParseNumber(std::string_view& input) {
    size_t i = 0;
    bool negative = false;
    if (!input.empty() && input.front() == '-') {
        negative = true;
        ++i;
    }
    while (i < input.size() && std::isdigit(static_cast<unsigned char>(input[i])))
        ++i;
    bool isFloat = false;
    if (i < input.size() && input[i] == '.') {
        isFloat = true;
        ++i;
        while (i < input.size() && std::isdigit(static_cast<unsigned char>(input[i])))
            ++i;
    }
    if (i < input.size() && (input[i] == 'e' || input[i] == 'E')) {
        isFloat = true;
        ++i;
        if (i < input.size() && (input[i] == '+' || input[i] == '-')) ++i;
        while (i < input.size() && std::isdigit(static_cast<unsigned char>(input[i])))
            ++i;
    }
    std::string numStr(input.data(), i);
    input.remove_prefix(i);
    char* end = nullptr;
    double val = std::strtod(numStr.c_str(), &end);
    return val;
}

static JsonValue ParseValue(std::string_view& input) {
    input = TrimWhitespace(input);
    if (input.empty()) throw std::runtime_error("Unexpected end of JSON");

    switch (input.front()) {
        case '"': return JsonValue(ParseString(input));
        case '{': {
            input.remove_prefix(1); // skip '{'
            JsonObject obj;
            input = TrimWhitespace(input);
            if (!input.empty() && input.front() == '}') {
                input.remove_prefix(1);
                return JsonValue(obj);
            }
            while (true) {
                input = TrimWhitespace(input);
                if (input.empty()) throw std::runtime_error("Unexpected end of object");
                if (input.front() != '"') throw std::runtime_error("Expected string key");
                auto key = ParseString(input);
                input = TrimWhitespace(input);
                if (input.empty() || input.front() != ':') throw std::runtime_error("Expected ':'");
                input.remove_prefix(1); // skip ':'
                obj[key] = ParseValue(input);
                input = TrimWhitespace(input);
                if (input.empty()) throw std::runtime_error("Unexpected end of object");
                if (input.front() == '}') {
                    input.remove_prefix(1);
                    break;
                }
                if (input.front() != ',') throw std::runtime_error("Expected ',' or '}'");
                input.remove_prefix(1); // skip ','
            }
            return JsonValue(std::move(obj));
        }
        case 't':
            if (input.substr(0, 4) == "true") {
                input.remove_prefix(4);
                return JsonValue(true);
            }
            throw std::runtime_error("Invalid token");
        case 'f':
            if (input.substr(0, 5) == "false") {
                input.remove_prefix(5);
                return JsonValue(false);
            }
            throw std::runtime_error("Invalid token");
        case 'n':
            if (input.substr(0, 4) == "null") {
                input.remove_prefix(4);
                return JsonValue(nullptr);
            }
            throw std::runtime_error("Invalid token");
        default:
            if (input.front() == '-' || std::isdigit(static_cast<unsigned char>(input.front())))
                return JsonValue(ParseNumber(input));
            throw std::runtime_error("Unexpected character in JSON");
    }
}

// ─── Public API ───────────────────────────────────────────────────────

JsonObject ParseJson(std::string_view json) {
    auto input = TrimWhitespace(json);
    if (input.empty() || input.front() != '{')
        throw std::runtime_error("Expected JSON object starting with '{'");
    auto val = ParseValue(input);
    return std::move(std::get<JsonObject>(val));
}

std::string SerializeJson(const JsonObject& obj) {
    std::ostringstream os;
    os << "{";
    bool first = true;
    for (const auto& [key, value] : obj) {
        if (!first) os << ",";
        first = false;
        os << "\"" << key << "\":";
        if (std::holds_alternative<std::nullptr_t>(value)) {
            os << "null";
        } else if (std::holds_alternative<bool>(value)) {
            os << (std::get<bool>(value) ? "true" : "false");
        } else if (std::holds_alternative<double>(value)) {
            double d = std::get<double>(value);
            if (d == static_cast<int64_t>(d)) {
                os << static_cast<int64_t>(d);
            } else {
                os << d;
            }
        } else if (std::holds_alternative<std::string>(value)) {
            const auto& s = std::get<std::string>(value);
            os << "\"";
            for (char c : s) {
                switch (c) {
                    case '"': os << "\\\""; break;
                    case '\\': os << "\\\\"; break;
                    case '\n': os << "\\n"; break;
                    case '\r': os << "\\r"; break;
                    case '\t': os << "\\t"; break;
                    default: os << c;
                }
            }
            os << "\"";
        }
    }
    os << "}";
    return os.str();
}

const std::string* GetString(const JsonObject& obj, const std::string& key) {
    auto it = obj.find(key);
    if (it != obj.end() && std::holds_alternative<std::string>(it->second))
        return &std::get<std::string>(it->second);
    return nullptr;
}

double GetNumber(const JsonObject& obj, const std::string& key, double fallback) {
    auto it = obj.find(key);
    if (it != obj.end() && std::holds_alternative<double>(it->second))
        return std::get<double>(it->second);
    return fallback;
}

bool GetBool(const JsonObject& obj, const std::string& key, bool fallback) {
    auto it = obj.find(key);
    if (it != obj.end() && std::holds_alternative<bool>(it->second))
        return std::get<bool>(it->second);
    return fallback;
}

} // namespace screenlink::video
