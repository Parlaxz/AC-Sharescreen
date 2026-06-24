#ifndef SCREENLINK_EXCLUSION_POLICY_H
#define SCREENLINK_EXCLUSION_POLICY_H

#include <cstdint>
#include <string>

namespace screenlink::audio {

/// Structured identity descriptor for ScreenLink process identification.
/// Replaces the single-PID model with verifiable evidence-based matching.
struct ScreenLinkIdentity {
    // Current root PID and creation time (always set)
    uint32_t rootPid = 0;
    uint64_t rootCreationTimeUtc100ns = 0;

    // Normalized packaged executable path (set when running packaged)
    std::string normalizedPackagedPath;

    // Normalized application installation or resources root (packaged)
    std::string normalizedInstallationRoot;

    // Normalized development application root (set when running under Electron)
    std::string normalizedDevAppRoot;

    // Normalized development Electron entrypoint or launch identity
    std::string normalizedDevEntrypoint;

    // Product/application identifier
    std::string productIdentifier;

    // Helper executable identity (always the helper's own path)
    std::string helperExePath;

    bool IsValid() const noexcept {
        return rootPid != 0 && rootCreationTimeUtc100ns != 0;
    }

    /// Normalize a Windows path for comparison: absolute, case-insensitive,
    /// separator-normalized, quote-stripped, dot-segment normalized.
    /// Uses GetFullPathNameW for real Windows canonicalization.
    static std::string NormalizePath(const std::string& rawPath);

    /// Check if `child` is contained within `parent` with DIRECTORY-BOUNDARY
    /// awareness. Both paths are canonicalized via GetFullPathNameW, then
    /// checks if child starts with parent + backslash.
    /// Example: C:\Program Files\ScreenLink\app.exe IS inside C:\Program Files\ScreenLink
    ///          C:\Program Files\ScreenLink-Evil\app.exe is NOT inside C:\Program Files\ScreenLink
    static bool IsPathContainedIn(const std::string& child, const std::string& parent);

    /// Check if a given PID+creation-time combo matches the current root.
    bool IsCurrentRoot(uint32_t pid, uint64_t creationTime) const noexcept;

    /// Check if a given path matches any ScreenLink application identity path.
    bool IsScreenLinkApplication(const std::string& path) const;

    /// Check if path matches the helper executable.
    bool IsHelperExecutable(const std::string& path) const;
};

/// Result of an exclusion policy check.
struct ExclusionMatch {
    bool isDiscord = false;
    bool isScreenLink = false;
    std::string matchedName;
    std::string exclusionReason; // Enum-like reason code for diagnostics
};

/// Check if a process name matches Discord variants (case-insensitive).
/// Matches: discord.exe, discordptb.exe, discordcanary.exe, discorddevelopment.exe
bool IsDiscordProcess(const std::string& processName);

/// Check if a process name or path matches ScreenLink (case-insensitive).
/// Matches any process whose basename contains "screenlink".
bool IsScreenLinkProcess(const std::string& processName, const std::string& processPath);

/// Apply exclusion policy to a resolved process identity.
ExclusionMatch CheckExclusion(const std::string& processName, const std::string& processPath);

/// Apply exclusion policy using the structured ScreenLink identity.
/// This is the preferred method for ScreenLink exclusion.
ExclusionMatch CheckExclusionV2(
    const std::string& processName,
    const std::string& processPath,
    const ScreenLinkIdentity& screenLinkIdentity);

} // namespace screenlink::audio

#endif // SCREENLINK_EXCLUSION_POLICY_H
