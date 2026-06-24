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
    // Check via ExclusionPolicy name/path matching
    if (IsScreenLinkProcess(session.executableName, session.executablePath)) {
        return true;
    }
    // Check if PID matches the known ScreenLink PID
    if (options.screenLinkPid != 0) {
        if (session.pid == options.screenLinkPid) {
            return true;
        }
        // Check if resolved root PID matches
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
        ProcessTreeResult tree = ResolveProcessTree(session.pid);
        if (!tree.succeeded || tree.applicationRootPid == 0) {
            plan.invalidSessions++;
            continue;
        }

        // --- Build candidate ---
        CandidateEntry entry;
        entry.candidate.identity.pid = session.pid;
        entry.candidate.identity.creationTimeUtc100ns = session.creationTimeUtc100ns;
        entry.candidate.sessionPid = session.pid;
        entry.candidate.executableName = session.executableName;
        entry.candidate.executablePath = session.executablePath;
        entry.candidate.activeSession = (session.sessionState == 1); // AudioSessionStateActive

        // Extract root process info from the resolved tree (last element = root)
        if (!tree.processes.empty()) {
            const auto& rootProc = tree.processes.back();

            entry.candidate.rootExecutableName =
                rootProc.processName;

            entry.candidate.rootExecutablePath =
                rootProc.processPath;

            entry.rootIdentity.pid =
                rootProc.processId;

            entry.rootIdentity.creationTimeUtc100ns =
                rootProc.creationTimeUtc100ns;
        } else {
            entry.candidate.rootExecutableName =
                tree.applicationRootName;

            entry.rootIdentity.pid =
                tree.applicationRootPid;

            entry.rootIdentity.creationTimeUtc100ns =
                GetProcessCreationTime(tree.applicationRootPid);
        }

        if (!entry.rootIdentity.IsValid()) {
            plan.invalidSessions++;
            continue;
        }

        // Capture the resolved application process tree, not the leaf
        // process that happened to own this individual audio session.
        entry.candidate.identity = entry.rootIdentity;

        // --- Step 6: Apply Discord exclusion ---
        if (options.excludeDiscord && IsDiscordSession(session)) {
            plan.discordExcluded++;
            continue;
        }

        // --- Step 7: Apply ScreenLink exclusion ---
        if (options.excludeScreenLink && IsScreenLinkSession(session, options)) {
            plan.screenLinkExcluded++;
            continue;
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
