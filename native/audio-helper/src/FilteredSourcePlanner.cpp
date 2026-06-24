#include "FilteredSourcePlanner.h"
#include "ProcessResolver.h"
#include "ExclusionPolicy.h"
#include "MultiSourceMixer.h"

#include <algorithm>
#include <cctype>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace screenlink::audio {

FilteredSourcePlanner::FilteredSourcePlanner(
    ResolveProcessTreeFn resolver)
    : resolveProcessTree_(std::move(resolver))
{
}

namespace {

/// Case-insensitive string lowercase conversion.
std::string ToLower(const std::string& s) {
    std::string result;
    result.reserve(s.size());
    for (char c : s) {
        result.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    }
    return result;
}

} // anonymous namespace

bool FilteredSourcePlanner::IsDiscordSession(const AudioSessionInfo& session) const {
    // Check via ExclusionPolicy name matching
    if (IsDiscordProcess(session.executableName)) {
        return true;
    }
    // Path-based check: Update.exe under a Discord install directory
    std::string lowerName = ToLower(session.executableName);
    if (lowerName == "update.exe") {
        std::string lowerPath = ToLower(session.executablePath);
        if (lowerPath.find("discord") != std::string::npos) {
            return true;
        }
    }
    return false;
}

bool FilteredSourcePlanner::IsScreenLinkSession(
    const AudioSessionInfo& session,
    const FilteredMonitorOptions& options) const
{
    // Check via ExclusionPolicy name/path matching (basename fallback)
    if (IsScreenLinkProcess(session.executableName, session.executablePath)) {
        return true;
    }

    // Check against structured ScreenLinkIdentity (preferred method)
    const auto& identity = options.screenLinkIdentity;
    if (identity.IsValid()) {
        // Check by current root PID + creation time (BOTH must match)
        if (identity.IsCurrentRoot(session.pid, session.creationTimeUtc100ns)) {
            return true;
        }
        // Check if resolved root identity matches (BOTH PID + creationTimeUtc100ns)
        if (session.rootPid != 0 &&
            identity.IsCurrentRoot(session.rootPid, session.rootCreationTimeUtc100ns)) {
            return true;
        }
        // Check application identity via session executable path
        if (!session.executablePath.empty() &&
            identity.IsScreenLinkApplication(session.executablePath)) {
            return true;
        }
    }
    // When structured identity is NOT valid (identity.IsValid() false), we fall
    // back to the legacy single-PID check below. This handles cases where the
    // desktop-side identity build failed or identity hasn't been provided yet.
    // Both PID and creation time must match in the structured branch above;
    // the legacy branch below uses only PID (backward compatibility).

    // Fallback: legacy single-PID check (maintains backward compat)
    if (options.screenLinkPid != 0) {
        if (session.pid == options.screenLinkPid) {
            return true;
        }
        if (session.rootPid != 0 && session.rootPid == options.screenLinkPid) {
            return true;
        }
    }
    return false;
}

FilteredSourcePlan FilteredSourcePlanner::Plan(
    const std::vector<AudioSessionInfo>& sessions,
    const FilteredMonitorOptions& options) const
{
    FilteredSourcePlan plan;

    // Temporary storage: candidate + its resolved root identity
    struct CandidateEntry {
        FilteredSourceCandidate candidate;
        ProcessIdentity rootIdentity;
    };
    std::vector<CandidateEntry> entries;

    for (const auto& session : sessions) {
        plan.totalSessions++;

        // --- Step 1: Skip system sounds (PID 0 or systemSound flag) ---
        if (session.pid == 0 || session.systemSound) {
            plan.systemSoundsSkipped++;
            continue;
        }

        // --- Identity/liveness diagnostics for non-system sessions ---

        // identityLookupFailures: clean invalid state from failed lookup
        if (!session.identityValidated && !session.processAlive &&
            session.creationTimeUtc100ns == 0) {
            plan.identityLookupFailures++;
        }

        // inconsistentIdentity: any contradictory combination
        if (!HasConsistentProcessIdentity(session)) {
            plan.inconsistentIdentitySessions++;
        }

        // validatedLive: fully validated live process
        if (session.processAlive && session.identityValidated &&
            session.creationTimeUtc100ns != 0) {
            plan.validatedLiveSessions++;
        }

        // --- Step 2: Skip expired sessions (process no longer alive) ---
        if (!session.processAlive) {
            plan.expiredSessions++;
            continue;
        }

        // --- Step 3: Accept both active and inactive non-expired sessions ---
        if (session.sessionState == 1) { // AudioSessionStateActive
            plan.activeSessions++;
        } else {
            plan.inactiveSessions++;
        }

        // --- Step 4: Validate identity ---
        if (session.pid == 0 || session.creationTimeUtc100ns == 0 || !session.identityValidated) {
            plan.invalidSessions++;
            continue;
        }

        // --- Step 5: Resolve process tree ---
        ProcessTreeResult tree = resolveProcessTree_(session.pid);
        if (!tree.succeeded || tree.applicationRootPid == 0) {
            plan.invalidSessions++;
            continue;
        }

        // --- Build candidate ---
        CandidateEntry entry;

        // Step 5a: Set candidate identity to the AUTHORITATIVE application root
        // from ProcessResolver, NOT tree.processes.back() or session.pid.
        entry.candidate.identity.pid = tree.applicationRootPid;
        entry.candidate.identity.creationTimeUtc100ns = tree.applicationRootCreationTimeUtc100ns;
        entry.candidate.sessionPid = session.pid;
        entry.candidate.executableName = session.executableName;
        entry.candidate.executablePath = session.executablePath;
        entry.candidate.activeSession = (session.sessionState == 1); // AudioSessionStateActive
        entry.candidate.rootExecutableName = tree.applicationRootName;
        entry.candidate.rootExecutablePath = tree.applicationRootPath;

        // rootIdentity is the same as candidate.identity (both are the
        // authoritative application root from ProcessResolver).
        entry.rootIdentity = entry.candidate.identity;

        if (!entry.rootIdentity.IsValid()) {
            plan.invalidSessions++;
            continue;
        }

        // --- Step 6: Apply Discord exclusion (check both session AND root level) ---
        if (options.excludeDiscord) {
            bool discordExcluded = false;
            // Session-level check
            if (IsDiscordSession(session)) {
                discordExcluded = true;
            }
            // Root-level check
            if (!discordExcluded && IsDiscordProcess(tree.applicationRootName)) {
                discordExcluded = true;
            }
            // Root-level Update.exe + Discord path check
            if (!discordExcluded) {
                std::string rootNameLower = ToLower(tree.applicationRootName);
                if (rootNameLower == "update.exe") {
                    std::string rootPathLower = ToLower(tree.applicationRootPath);
                    if (rootPathLower.find("discord") != std::string::npos) {
                        discordExcluded = true;
                    }
                }
            }
            if (discordExcluded) {
                plan.discordExcluded++;
                continue;
            }
        }

        // --- Step 7: Apply ScreenLink exclusion (check both session AND root level) ---
        if (options.excludeScreenLink) {
            bool slExcluded = false;
            // Session-level check using structured identity
            if (IsScreenLinkSession(session, options)) {
                slExcluded = true;
            }
            // Root-level check using structured identity
            if (!slExcluded) {
                // Check via CheckExclusionV2 for the root identity
                auto rootMatch = CheckExclusionV2(
                    tree.applicationRootName,
                    tree.applicationRootPath,
                    options.screenLinkIdentity);
                if (rootMatch.isScreenLink) {
                    slExcluded = true;
                }
            }
            // Fallback root-level basename check
            if (!slExcluded && IsScreenLinkProcess(tree.applicationRootName, tree.applicationRootPath)) {
                slExcluded = true;
            }
            if (slExcluded) {
                plan.screenLinkExcluded++;
                continue;
            }
        }

        entries.push_back(std::move(entry));
    }

    // --- Step 8: Deduplicate by resolved root ProcessIdentity ---
    // Keep one entry per unique root identity. Prefer active sessions over inactive.
    std::unordered_map<ProcessIdentity, std::size_t, ProcessIdentityHash> rootToEntryIndex;
    for (std::size_t i = 0; i < entries.size(); ++i) {
        const auto& rootId = entries[i].rootIdentity;
        auto it = rootToEntryIndex.find(rootId);
        if (it != rootToEntryIndex.end()) {
            // Duplicate root found – keep whichever has an active session
            if (entries[i].candidate.activeSession &&
                !entries[it->second].candidate.activeSession) {
                it->second = i; // Replace with the active one
            }
            plan.duplicateRoots++;
        } else {
            rootToEntryIndex[rootId] = i;
        }
    }

    // Collect deduplicated candidates into a flat vector
    std::vector<FilteredSourceCandidate> candidates;
    candidates.reserve(rootToEntryIndex.size());
    for (const auto& [_, idx] : rootToEntryIndex) {
        candidates.push_back(std::move(entries[idx].candidate));
    }

    // --- Step 9: Sort ---
    // Active before inactive, then lowercase root name ascending,
    // then PID ascending, then creation time ascending.
    std::sort(candidates.begin(), candidates.end(),
        [](const FilteredSourceCandidate& a, const FilteredSourceCandidate& b) {
            // Active sessions first
            if (a.activeSession != b.activeSession) {
                return a.activeSession > b.activeSession;
            }
            // Lowercase root executable name ascending
            std::string nameA = ToLower(a.rootExecutableName);
            std::string nameB = ToLower(b.rootExecutableName);
            if (nameA != nameB) {
                return nameA < nameB;
            }
            // PID ascending
            if (a.identity.pid != b.identity.pid) {
                return a.identity.pid < b.identity.pid;
            }
            // Creation time ascending
            return a.identity.creationTimeUtc100ns < b.identity.creationTimeUtc100ns;
        });

    // --- Step 10: Limit to MultiSourceMixer::kMaxSources ---
    if (candidates.size() > MultiSourceMixer::kMaxSources) {
        plan.sourceLimitSkipped =
            static_cast<uint32_t>(candidates.size() - MultiSourceMixer::kMaxSources);
        candidates.resize(MultiSourceMixer::kMaxSources);
    }

    plan.desiredSources = std::move(candidates);
    return plan;
}

} // namespace screenlink::audio
