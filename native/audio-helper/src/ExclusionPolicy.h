#ifndef SCREENLINK_EXCLUSION_POLICY_H
#define SCREENLINK_EXCLUSION_POLICY_H

#include <string>

namespace screenlink::audio {

/// Result of an exclusion policy check.
struct ExclusionMatch {
    bool isDiscord = false;
    bool isScreenLink = false;
    std::string matchedName;
};

/// Check if a process name matches Discord variants (case-insensitive).
/// Matches: discord.exe, discordptb.exe, discordcanary.exe, discorddevelopment.exe
bool IsDiscordProcess(const std::string& processName);

/// Check if a process name or path matches ScreenLink (case-insensitive).
/// Matches any process whose basename contains "screenlink".
bool IsScreenLinkProcess(const std::string& processName, const std::string& processPath);

/// Apply exclusion policy to a resolved process identity.
ExclusionMatch CheckExclusion(const std::string& processName, const std::string& processPath);

} // namespace screenlink::audio

#endif // SCREENLINK_EXCLUSION_POLICY_H
