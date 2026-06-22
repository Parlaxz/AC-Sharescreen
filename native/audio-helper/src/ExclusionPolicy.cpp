#include "ExclusionPolicy.h"

#include <algorithm>
#include <cctype>
#include <string>

namespace screenlink::audio {

namespace {

// Case-insensitive string equality.
bool IEquals(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); ++i) {
        if (std::tolower(static_cast<unsigned char>(a[i])) !=
            std::tolower(static_cast<unsigned char>(b[i]))) {
            return false;
        }
    }
    return true;
}

// Case-insensitive substring search.
bool IContains(const std::string& haystack, const std::string& needle) {
    auto it = std::search(
        haystack.begin(), haystack.end(),
        needle.begin(), needle.end(),
        [](unsigned char c1, unsigned char c2) {
            return std::tolower(c1) == std::tolower(c2);
        });
    return it != haystack.end();
}

// Extract file basename from a path.
std::string Basename(const std::string& path) {
    auto pos = path.rfind('\\');
    if (pos == std::string::npos) {
        pos = path.rfind('/');
    }
    if (pos == std::string::npos) return path;
    return path.substr(pos + 1);
}

} // anonymous namespace

bool IsDiscordProcess(const std::string& processName) {
    static const char* kDiscordVariants[] = {
        "discord.exe",
        "discordptb.exe",
        "discordcanary.exe",
        "discorddevelopment.exe",
    };

    std::string name = Basename(processName);
    for (const auto* variant : kDiscordVariants) {
        if (IEquals(name, variant)) return true;
    }
    return false;
}

bool IsScreenLinkProcess(const std::string& processName, const std::string& processPath) {
    std::string name = Basename(processName);
    if (IContains(name, "screenlink")) return true;

    if (!processPath.empty()) {
        std::string pathBase = Basename(processPath);
        if (IContains(pathBase, "screenlink")) return true;
    }
    return false;
}

ExclusionMatch CheckExclusion(const std::string& processName, const std::string& processPath) {
    ExclusionMatch match;

    if (IsDiscordProcess(processName)) {
        match.isDiscord = true;
        match.matchedName = Basename(processName);
    } else if (IsScreenLinkProcess(processName, processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processName.empty() ? processPath : processName);
    }

    return match;
}

} // namespace screenlink::audio
