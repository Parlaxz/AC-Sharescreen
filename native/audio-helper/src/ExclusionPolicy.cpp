#include "ExclusionPolicy.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <unordered_map>
#include <vector>

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

// Strip quotes from a path string.
std::string StripQuotes(const std::string& s) {
    if (s.size() >= 2 && s.front() == '"' && s.back() == '"') {
        return s.substr(1, s.size() - 2);
    }
    return s;
}

} // anonymous namespace

// ── ScreenLinkIdentity implementation ──

std::string ScreenLinkIdentity::NormalizePath(const std::string& rawPath) {
    if (rawPath.empty()) return {};

    // Strip quotes
    std::string result = StripQuotes(rawPath);

    // Convert to lowercase
    for (auto& c : result) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    // Normalize separators to backslash
    for (auto& c : result) {
        if (c == '/') c = '\\';
    }

    // Remove trailing backslash (but preserve root like "c:\")
    if (result.size() > 3 && result.back() == '\\') {
        result.pop_back();
    }

    // Collapse consecutive separators
    std::string collapsed;
    collapsed.reserve(result.size());
    for (size_t i = 0; i < result.size(); ++i) {
        if (result[i] == '\\' && i + 1 < result.size() && result[i + 1] == '\\') {
            continue; // skip duplicate
        }
        collapsed += result[i];
    }

    return collapsed;
}

bool ScreenLinkIdentity::IsCurrentRoot(uint32_t pid, uint64_t creationTime) const noexcept {
    return rootPid == pid && rootCreationTimeUtc100ns == creationTime;
}

bool ScreenLinkIdentity::IsScreenLinkApplication(const std::string& path) const {
    if (path.empty()) return false;
    std::string normalized = NormalizePath(path);
    if (normalized.empty()) return false;

    // Check against normalized packaged path
    if (!normalizedPackagedPath.empty()) {
        if (IEquals(normalized, normalizedPackagedPath)) return true;
    }

    // Check against installation root
    if (!normalizedInstallationRoot.empty()) {
        if (normalized.find(normalizedInstallationRoot) == 0) return true;
    }

    // Check against development app root
    if (!normalizedDevAppRoot.empty()) {
        if (normalized.find(normalizedDevAppRoot) == 0) return true;
    }

    // Check against development entrypoint
    if (!normalizedDevEntrypoint.empty()) {
        if (IEquals(normalized, normalizedDevEntrypoint)) return true;
    }

    // Basename fallback: check if path contains "screenlink" (existing behavior)
    std::string base = Basename(path);
    if (IContains(base, "screenlink")) return true;

    return false;
}

bool ScreenLinkIdentity::IsHelperExecutable(const std::string& path) const {
    if (path.empty() || helperExePath.empty()) return false;
    return IEquals(NormalizePath(path), NormalizePath(helperExePath));
}

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
        match.exclusionReason = "discord-basename";
    } else if (IsScreenLinkProcess(processName, processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processName.empty() ? processPath : processName);
        match.exclusionReason = "screenlink-basename";
    }

    return match;
}

ExclusionMatch CheckExclusionV2(
    const std::string& processName,
    const std::string& processPath,
    const ScreenLinkIdentity& screenLinkIdentity)
{
    ExclusionMatch match;

    // 1. Discord exclusion (unchanged)
    if (IsDiscordProcess(processName)) {
        match.isDiscord = true;
        match.matchedName = Basename(processName);
        match.exclusionReason = "discord-basename";
        return match;
    }

    // 2. Helper executable exclusion
    if (!processPath.empty() && screenLinkIdentity.IsHelperExecutable(processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processPath);
        match.exclusionReason = "screenlink-helper-executable";
        return match;
    }

    // 3. Current root exclusion (exact PID + creation time)
    // This is already handled by the PID check in IsScreenLinkSession,
    // but we also check at root level for completeness.
    // (The PID match is done in FilteredSourcePlanner)

    // 4. ScreenLink application identity check
    if (!processPath.empty() && screenLinkIdentity.IsScreenLinkApplication(processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processPath);
        match.exclusionReason = "screenlink-application-identity";
        return match;
    }

    // 5. Basename fallback: existing IsScreenLinkProcess check
    if (IsScreenLinkProcess(processName, processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processName.empty() ? processPath : processName);
        match.exclusionReason = "screenlink-basename-fallback";
        return match;
    }

    return match;
}

} // namespace screenlink::audio
