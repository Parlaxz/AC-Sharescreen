#include "ExclusionPolicy.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

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

    // Step 1: Strip quotes
    std::string stripped = StripQuotes(rawPath);
    if (stripped.empty()) return {};

    // Step 2: Convert to wide string
    int wideLen = MultiByteToWideChar(CP_UTF8, 0, stripped.c_str(), -1, nullptr, 0);
    if (wideLen <= 0) return {};
    std::wstring wide(static_cast<size_t>(wideLen) - 1, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, stripped.c_str(), -1, &wide[0], wideLen);

    // Step 3: Call GetFullPathNameW to canonicalize (resolves dots,
    //         normalizes separators, makes absolute)
    wchar_t canonical[MAX_PATH + 1] = {};
    DWORD resultLen = GetFullPathNameW(wide.c_str(), MAX_PATH, canonical, nullptr);
    if (resultLen == 0 || resultLen > MAX_PATH) return {};

    // Step 4: Convert back to UTF-8
    int utf8Len = WideCharToMultiByte(CP_UTF8, 0, canonical, -1, nullptr, 0, nullptr, nullptr);
    if (utf8Len <= 0) return {};
    std::string result(static_cast<size_t>(utf8Len) - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, canonical, -1, &result[0], utf8Len, nullptr, nullptr);
    if (result.empty()) return {};

    // Step 5: Convert to lowercase
    for (auto& c : result) {
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    }

    // Step 6: Strip trailing backslash (but preserve root like "c:\")
    if (result.size() > 3 && result.back() == '\\') {
        result.pop_back();
    }

    return result;
}

bool ScreenLinkIdentity::IsPathContainedIn(const std::string& child, const std::string& parent) {
    std::string normalizedChild = NormalizePath(child);
    std::string normalizedParent = NormalizePath(parent);

    if (normalizedChild.empty() || normalizedParent.empty()) return false;

    // Reject drive roots as parents (e.g., "c:\") — they would match everything.
    if (normalizedParent.size() == 3 && normalizedParent[1] == ':' && normalizedParent[2] == '\\') {
        return false;
    }

    // Reject "Program Files" as a parent — too broad a scope.
    // After normalization: "c:\program files" ends with "\program files".
    const std::string kProgramFilesSuffix = "\\program files";
    if (normalizedParent.size() >= kProgramFilesSuffix.size() &&
        normalizedParent.compare(normalizedParent.size() - kProgramFilesSuffix.size(),
                                  kProgramFilesSuffix.size(), kProgramFilesSuffix) == 0) {
        return false;
    }

    // Build parent-with-trailing-backslash for the boundary check.
    // NormalizePath strips trailing backslash, so we add it back here.
    std::string parentBoundary = normalizedParent;
    if (parentBoundary.back() != '\\') {
        parentBoundary += '\\';
    }

    // DIRECTORY-BOUNDARY check: child must start with parent + backslash.
    // This ensures C:\Program Files\ScreenLink-Evil does NOT match
    // parent C:\Program Files\ScreenLink because the child path
    // continues with "\screenlink-evil\" not "\screenlink\".
    return normalizedChild.find(parentBoundary) == 0;
}

bool ScreenLinkIdentity::IsCurrentRoot(uint32_t pid, uint64_t creationTime) const noexcept {
    return rootPid == pid && rootCreationTimeUtc100ns == creationTime;
}

bool ScreenLinkIdentity::IsScreenLinkApplication(const std::string& path) const {
    if (path.empty()) return false;
    std::string normalized = NormalizePath(path);
    if (normalized.empty()) return false;

    // 1. Packaged identity: exact match against packaged executable path
    if (HasPackagedIdentity()) {
        if (IEquals(normalized, normalizedPackagedPath)) return true;
    }

    // 2. Packaged identity + isPackaged: directory containment against
    //    installation root (NARROW scope — never broad like "Program Files")
    if (isPackaged && HasPackagedIdentity() && !normalizedInstallationRoot.empty()) {
        if (IsPathContainedIn(normalized, normalizedInstallationRoot)) return true;
    }

    // 3. Development identity: directory containment against dev app root
    if (HasDevelopmentIdentity() && !normalizedDevAppRoot.empty()) {
        if (IsPathContainedIn(normalized, normalizedDevAppRoot)) return true;
    }

    // 4. Development identity: exact match against entrypoint
    if (HasDevelopmentIdentity() && !normalizedDevEntrypoint.empty()) {
        if (IEquals(normalized, normalizedDevEntrypoint)) return true;
    }

    // NOTE: Basename substring check (IContains) intentionally removed.
    // The ONLY fallback for ScreenLink identification is IsScreenLinkProcess()
    // in CheckExclusionV2, not in structured identity matching.

    return false;
}

bool ScreenLinkIdentity::IsScreenLinkSibling(const std::string& path) const {
    // Sibling identity check uses only packaged and development identity fields.
    // Does NOT require current-process identity (PID + creation time).
    // Delegates to IsScreenLinkApplication which uses the same field checks.
    return IsScreenLinkApplication(path);
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

    // 2. Helper executable exclusion (no identity required)
    if (!processPath.empty() && screenLinkIdentity.IsHelperExecutable(processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processPath);
        match.exclusionReason = "screenlink-helper-executable";
        return match;
    }

    // 3. ScreenLink application identity check (packaged + development identity)
    // Covers both:
    //   - Packaged sibling identity (uses normalizedPackagedPath + isPackaged + installationRoot)
    //   - Development sibling identity (uses normalizedDevAppRoot + normalizedDevEntrypoint)
    // Does NOT require current-process identity (PID + creation time).
    if (!processPath.empty() && screenLinkIdentity.IsScreenLinkApplication(processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processPath);
        match.exclusionReason = "screenlink-application-identity";
        return match;
    }

    // 4. Basename fallback: only when structured identity found nothing
    if (IsScreenLinkProcess(processName, processPath)) {
        match.isScreenLink = true;
        match.matchedName = Basename(processName.empty() ? processPath : processName);
        match.exclusionReason = "screenlink-basename-fallback";
        return match;
    }

    return match;
}

} // namespace screenlink::audio
