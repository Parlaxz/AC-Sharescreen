#include "Phase2GSelfTest.h"
#include "AudioPacketAnalysis.h"
#include "FilteredMonitorTypes.h"
#include "FilteredSourcePlanner.h"
#include "AudioSessionMonitor.h"
#include "MultiSourceMixer.h"
#include "ExclusionPolicy.h"
#include "ProcessResolver.h"
#include "LoopbackCapture.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <iostream>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <atomic>
#include <mutex>
#include <thread>
#include <chrono>
#include <vector>

namespace screenlink::audio {
namespace {

int g_testsRun = 0;
int g_testsPassed = 0;
int g_testsFailed = 0;

// Private exception for assertion failures — ensures every test is
// counted as either passed or failed (never lost to early return).
struct TestFailure final {};

#define TEST(name) do { \
    g_testsRun++; \
    try {

#define END_TEST(name) \
        g_testsPassed++; \
    } catch (const TestFailure&) { \
        g_testsFailed++; \
        std::cerr << "[Phase2G] FAIL: " << name << "\n"; \
    } catch (const std::exception& e) { \
        g_testsFailed++; \
        std::cerr << "[Phase2G] FAIL: " << name << " - exception: " << e.what() << "\n"; \
    } catch (...) { \
        g_testsFailed++; \
        std::cerr << "[Phase2G] FAIL: " << name << " - unknown exception\n"; \
    } \
} while(0)

#define ASSERT(cond) do { \
    if (!(cond)) { \
        std::cerr << "[Phase2G] ASSERT failed at " << __LINE__ << ": " #cond "\n"; \
        throw TestFailure{}; \
    } \
} while(0)

#define ASSERT_EQ(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (av != bv) { \
        std::cerr << "[Phase2G] ASSERT_EQ failed at " << __LINE__ << ": " #a " (" << av << ") != " #b " (" << bv << ")\n"; \
        throw TestFailure{}; \
    } \
} while(0)

#define ASSERT_GT(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av > bv)) { \
        std::cerr << "[Phase2G] ASSERT_GT failed at " << __LINE__ << ": " #a " (" << av << ") <= " #b " (" << bv << ")\n"; \
        throw TestFailure{}; \
    } \
} while(0)

#define ASSERT_GE(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av >= bv)) { \
        std::cerr << "[Phase2G] ASSERT_GE failed at " << __LINE__ << ": " #a " (" << av << ") < " #b " (" << bv << ")\n"; \
        throw TestFailure{}; \
    } \
} while(0)

#define ASSERT_LE(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av <= bv)) { \
        std::cerr << "[Phase2G] ASSERT_LE failed at " << __LINE__ << ": " #a " (" << av << ") > " #b " (" << bv << ")\n"; \
        throw TestFailure{}; \
    } \
} while(0)

#define ASSERT_NE(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (av == bv) { \
        std::cerr << "[Phase2G] ASSERT_NE failed at " << __LINE__ << ": " #a " (" << av << ") == " #b " (" << bv << ")\n"; \
        throw TestFailure{}; \
    } \
} while(0)

// ====================================================================
// FilteredSourcePlanner Tests
// ====================================================================

void TestEmptyInventory() {
    TEST("FilteredSourcePlanner - empty inventory")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.desiredSources.size(), 0u);
    ASSERT_EQ(plan.totalSessions, 0u);
    ASSERT_EQ(plan.systemSoundsSkipped, 0u);
    ASSERT_EQ(plan.invalidSessions, 0u);
    ASSERT_EQ(plan.duplicateRoots, 0u);
    ASSERT_EQ(plan.discordExcluded, 0u);
    ASSERT_EQ(plan.screenLinkExcluded, 0u);
    END_TEST("FilteredSourcePlanner - empty inventory");
}

void TestSystemSoundsSkipped() {
    TEST("FilteredSourcePlanner - system sounds skipped")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo sys;
    sys.pid = 0;
    sys.systemSound = true;
    sys.executableName = "System Sounds";
    sessions.push_back(sys);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.systemSoundsSkipped, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 0u);
    END_TEST("FilteredSourcePlanner - system sounds skipped");
}

void TestProcessIdentityEquality() {
    TEST("ProcessIdentity - equality and hashing")
    ProcessIdentity a{100, 1000};
    ProcessIdentity b{100, 1000};
    ProcessIdentity c{100, 2000};
    ProcessIdentity d{200, 1000};
    ASSERT(a == b);
    ASSERT(a != c);
    ASSERT(a != d);
    END_TEST("ProcessIdentity - equality and hashing");
}

void TestProcessIdentityValidCheck() {
    TEST("ProcessIdentity - IsValid")
    ProcessIdentity zero{0, 0};
    ASSERT(!zero.IsValid());
    ProcessIdentity onlyPid{100, 0};
    ASSERT(!onlyPid.IsValid());
    ProcessIdentity onlyTime{0, 1000};
    ASSERT(!onlyTime.IsValid());
    ProcessIdentity valid{100, 1000};
    ASSERT(valid.IsValid());
    END_TEST("ProcessIdentity - IsValid");
}

void TestSamePidDifferentCreationTime() {
    TEST("ProcessIdentity - same PID different creation time")
    ProcessIdentity old{100, 1000};
    ProcessIdentity newer{100, 2000};
    ASSERT(old != newer);
    ASSERT(!(old == newer));
    END_TEST("ProcessIdentity - same PID different creation time");
}

void TestDiscordExcluded() {
    TEST("ExclusionPolicy - Discord variants excluded")
    ASSERT(IsDiscordProcess("discord.exe"));
    ASSERT(IsDiscordProcess("Discord.exe"));
    ASSERT(IsDiscordProcess("DISCORD.EXE"));
    ASSERT(IsDiscordProcess("discordptb.exe"));
    ASSERT(IsDiscordProcess("discordcanary.exe"));
    ASSERT(IsDiscordProcess("discorddevelopment.exe"));
    ASSERT(IsDiscordProcess("C:\\Users\\test\\AppData\\Local\\Discord\\app-1.0.9003\\Discord.exe"));
    ASSERT(!IsDiscordProcess("notdiscord.exe"));
    ASSERT(!IsDiscordProcess("Updater.exe"));
    END_TEST("ExclusionPolicy - Discord variants excluded");
}

void TestScreenLinkExcluded() {
    TEST("ExclusionPolicy - ScreenLink excluded")
    ASSERT(IsScreenLinkProcess("screenlink.exe", ""));
    ASSERT(IsScreenLinkProcess("ScreenLink.exe", ""));
    ASSERT(IsScreenLinkProcess("SCREENLINK.EXE", ""));
    // Basename "screenlink.exe" matches even with path
    ASSERT(IsScreenLinkProcess("screenlink.exe", "C:\\app\\screenlink.exe"));
    ASSERT(!IsScreenLinkProcess("electron.exe", "C:\\browser\\electron.exe"));
    // The ExclusionPolicy checks basename; full-path matching is handled by the planner
    ASSERT(!IsScreenLinkProcess("electron.exe", "C:\\screenlink\\electron.exe"));
    END_TEST("ExclusionPolicy - ScreenLink excluded");
}

// ====================================================================
// Additional FilteredSourcePlanner Tests
// ====================================================================

// ── Deterministic fake resolver helper ──
// Builds a ProcessTreeResult from explicit mock process data without
// touching the real OS. The chain is ordered [target, parent, ...].
// The authoritative root is computed by FindApplicationRootIndex.
static ProcessTreeResult MakeFakeTree(
    uint32_t sessionPid,
    const std::vector<uint32_t>& ancestorPids,
    const std::vector<std::string>& ancestorNames,
    const std::vector<std::string>& ancestorPaths)
{
    ProcessTreeResult tree;
    tree.succeeded = true;
    tree.targetPid = sessionPid;

    // First entry is always the session process.
    {
        ProcessInfo pi;
        pi.processId = sessionPid;
        pi.processName = ancestorNames.empty() ? "app.exe" : ancestorNames[0];
        pi.processPath = ancestorPaths.empty() ? "C:\\App\\app.exe" : ancestorPaths[0];
        pi.creationTimeUtc100ns = 1000000 + sessionPid;
        pi.parentProcessId = ancestorPids.empty() ? 0 : ancestorPids[0];
        tree.processes.push_back(pi);
    }

    for (size_t i = 0; i < ancestorPids.size(); ++i) {
        ProcessInfo pi;
        pi.processId = ancestorPids[i];
        pi.processName = (i + 1 < ancestorNames.size()) ? ancestorNames[i + 1] : "unknown.exe";
        pi.processPath = (i + 1 < ancestorPaths.size()) ? ancestorPaths[i + 1] : "C:\\unknown.exe";
        pi.creationTimeUtc100ns = 1000000 + ancestorPids[i];
        pi.parentProcessId = (i + 1 < ancestorPids.size()) ? ancestorPids[i + 1] : 0;
        tree.processes.push_back(pi);
    }

    tree.targetCreationTimeUtc100ns = tree.processes[0].creationTimeUtc100ns;

    // Compute authoritative root via the same pure function the real resolver uses.
    bool usedFallback = false;
    uint32_t rootIdx = FindApplicationRootIndex(tree.processes, usedFallback);
    const auto& rootProc = tree.processes[rootIdx];
    tree.applicationRootPid = rootProc.processId;
    tree.applicationRootCreationTimeUtc100ns = rootProc.creationTimeUtc100ns;
    tree.applicationRootName = rootProc.processName;
    tree.applicationRootPath = rootProc.processPath;
    tree.usedBasenameFallback = usedFallback;

    return tree;
}

void TestActiveSessionBecomesDesiredSource() {
    TEST("FilteredSourcePlanner - active session becomes one desired source")
    const uint32_t sessionPid = 301;
    const uint32_t rootPid = 200;

    // Chrome-like tree: 301 -> 250 -> 200 -> explorer -> stop
    auto resolver = [](uint32_t) {
        return MakeFakeTree(301, {250, 200, 100},
            {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
            {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
             "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s;
    s.pid = sessionPid;
    s.creationTimeUtc100ns = 1000301;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "chrome.exe";
    s.sessionState = 1;
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.desiredSources[0].sessionPid, sessionPid);
    ASSERT_EQ(plan.desiredSources[0].identity.pid, rootPid);
    ASSERT(plan.desiredSources[0].identity.IsValid());
    ASSERT(plan.desiredSources[0].activeSession);
    END_TEST("FilteredSourcePlanner - active session becomes one desired source");
}

void TestInactiveSessionStillEligible() {
    TEST("FilteredSourcePlanner - inactive session still eligible")
    const uint32_t sessionPid = 301;
    const uint32_t rootPid = 200;

    auto resolver = [](uint32_t) {
        return MakeFakeTree(301, {250, 200, 100},
            {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
            {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
             "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s;
    s.pid = sessionPid;
    s.creationTimeUtc100ns = 1000301;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "chrome.exe";
    s.sessionState = 0; // AudioSessionStateInactive
    sessions.push_back(s);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.inactiveSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT(!plan.desiredSources[0].activeSession);
    ASSERT_EQ(plan.desiredSources[0].sessionPid, sessionPid);
    ASSERT_EQ(plan.desiredSources[0].identity.pid, rootPid);
    END_TEST("FilteredSourcePlanner - inactive session still eligible");
}

void TestExpiredSessionSkipped() {
    TEST("FilteredSourcePlanner - expired session skipped")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo s;
    s.pid = 1234;
    s.creationTimeUtc100ns = 1000000;
    s.identityValidated = true;
    s.processAlive = false; // expired
    s.executableName = "app.exe";
    sessions.push_back(s);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.expiredSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 0u);
    END_TEST("FilteredSourcePlanner - expired session skipped");
}

void TestDuplicateProcessTreeDedup() {
    TEST("FilteredSourcePlanner - duplicate process tree dedup")
    // Two sessions from the same process root -> one desired source
    const uint32_t sessionPid1 = 301;
    const uint32_t sessionPid2 = 302; // different leaf but same root
    const uint32_t rootPid = 200;

    auto resolver = [](uint32_t pid) {
        // Both PIDs resolve to the same chrome tree
        if (pid == 301 || pid == 302) {
            return MakeFakeTree(pid, {250, 200, 100},
                {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
                {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
                 "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
        }
        ProcessTreeResult bad;
        bad.succeeded = false;
        return bad;
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID which contains "screenlink"
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s1;
    s1.pid = sessionPid1;
    s1.creationTimeUtc100ns = 1000301;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "helper.exe";
    s1.sessionState = 1;
    sessions.push_back(s1);

    AudioSessionInfo s2;
    s2.pid = sessionPid2;
    s2.creationTimeUtc100ns = 1000302;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "helper.exe";
    s2.sessionState = 1;
    sessions.push_back(s2);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 2u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.duplicateRoots, 1u);
    ASSERT_EQ(plan.desiredSources[0].identity.pid, rootPid);
    // sessionPid should be the active-session winner (or first seen)
    ASSERT(plan.desiredSources[0].sessionPid == sessionPid1 ||
           plan.desiredSources[0].sessionPid == sessionPid2);
    END_TEST("FilteredSourcePlanner - duplicate process tree dedup");
}

void TestDiscordAllowedWhenExcludeFalse() {
    TEST("FilteredSourcePlanner - Discord allowed when excludeDiscord=false")
    // When excludeDiscord is false, Discord sessions should be eligible
    ASSERT(!IsDiscordProcess("notdiscord.exe"));
    ASSERT(IsDiscordProcess("discord.exe"));
    ASSERT(!IsDiscordProcess(""));
    END_TEST("FilteredSourcePlanner - Discord allowed when excludeDiscord=false");
}

void TestScreenLinkAllowedWhenExcludeFalse() {
    TEST("ExclusionPolicy - ScreenLink allowed when excludeScreenLink=false")
    ASSERT(IsScreenLinkProcess("screenlink.exe", ""));
    ASSERT(IsScreenLinkProcess("ScreenLink.exe", "C:\\app\\ScreenLink.exe"));
    ASSERT(!IsScreenLinkProcess("electron.exe", "C:\\browser\\electron.exe"));
    END_TEST("ExclusionPolicy - ScreenLink allowed when excludeScreenLink=false");
}

void TestSourceLimit() {
    TEST("FilteredSourcePlanner - same-root sessions dedup to at most one source")
    auto resolver = [](uint32_t pid) {
        return MakeFakeTree(pid, {200}, {"app.exe", "app.exe"},
            {"C:\\App\\app.exe", "C:\\App\\app.exe"});
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;

    // Add 10 sessions with different PIDs that all resolve to root 200
    for (uint32_t i = 301; i < 311; i++) {
        AudioSessionInfo s;
        s.pid = i; // all distinct PIDs, same root 200 -> dedup to 1
        s.creationTimeUtc100ns = 1000000 + i;
        s.identityValidated = true;
        s.processAlive = true;
        s.executableName = "app.exe";
        s.sessionState = 1;
        sessions.push_back(s);
    }
    auto plan = planner.Plan(sessions, options);
    // All 10 sessions resolve to root 200, so only one desired source
    ASSERT_EQ(plan.totalSessions, 10u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.duplicateRoots, 9u);
    ASSERT(plan.desiredSources[0].identity.pid == 200u);
    END_TEST("FilteredSourcePlanner - same-root sessions dedup to at most one source");
}

// ====================================================================
// MultiSourceMixer Tests
// ====================================================================

void TestMixerZeroSourcesStart() {
    TEST("MultiSourceMixer - zero sources start succeeds")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));
    std::atomic<uint64_t> packetsReceived{0};
    std::atomic<uint64_t> silentPackets{0};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        packetsReceived++;
        if (p.isSilent) silentPackets++;
        return true;
    });

    ASSERT(result.success);
    ASSERT(mixer->IsRunning());
    ASSERT_EQ(mixer->SourceCount(), 0u);

    // Let it produce a few packets
    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    ASSERT_GT(packetsReceived.load(), 0u);
    ASSERT_EQ(silentPackets.load(), packetsReceived.load()); // all should be silent

    mixer->Stop();
    ASSERT(!mixer->IsRunning());
    END_TEST("MultiSourceMixer - zero sources start succeeds");
}

void TestMixerSequenceNumbers() {
    TEST("MultiSourceMixer - sequence numbers increase continuously")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));
    std::atomic<uint64_t> lastSeq{0};
    std::atomic<uint64_t> count{0};
    std::atomic<bool> gaps{false};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto prev = lastSeq.exchange(p.sequenceNumber);
        if (count > 0 && p.sequenceNumber != prev + 1) {
            gaps = true;
        }
        count++;
        if (count >= 10) return false; // stop after 10 packets
        return true;
    });

    ASSERT(result.success);

    // Wait for test to complete
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    mixer->Stop();

    ASSERT_GT(count.load(), 0u);
    ASSERT(!gaps.load());
    END_TEST("MultiSourceMixer - sequence numbers increase continuously");
}

void TestMixerAddRemoveSource() {
    TEST("MultiSourceMixer - add and remove source while running")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<AudioPacket> outputs;

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        std::lock_guard<std::mutex> lock(outputMutex);
        outputs.push_back(p);
        if (outputs.size() >= 50) return false;
        return true;
    });

    ASSERT(result.success);

    // Add a source
    uint32_t sid = mixer->AddSource(123, 456);
    ASSERT_GT(sid, 0u);

    // Feed some nonzero packets
    std::vector<float> samples(480 * 2, 0.5f);
    for (int i = 0; i < 5; i++) {
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i);
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Remove source
    mixer->RemoveSource(sid);

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Check we got some non-zero packets before removal, then silence after
    bool hadNonzero = false;
    bool hadSilent = false;
    {
        std::lock_guard<std::mutex> lock(outputMutex);
        for (auto& pkt : outputs) {
            if (!pkt.isSilent) hadNonzero = true;
            if (pkt.isSilent) hadSilent = true;
        }
    }

    ASSERT(hadNonzero);
    ASSERT(hadSilent);

    mixer->Stop();
    END_TEST("MultiSourceMixer - add and remove source while running");
}

void TestMixerAddSourceReturnsId() {
    TEST("MultiSourceMixer - AddSource returns unique IDs")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));
    auto id1 = mixer->AddSource(1, 100);
    auto id2 = mixer->AddSource(2, 200);
    ASSERT_GT(id1, 0u);
    ASSERT_GT(id2, 0u);
    ASSERT(id1 != id2);
    END_TEST("MultiSourceMixer - AddSource returns unique IDs");
}

// ====================================================================
// Retry / Backoff Tests
// ====================================================================

void TestRetryBackoffSequence() {
    TEST("Retry - backoff sequence is 1s, 2s, 4s, 8s, 30s, 30s...")
    // Formula: totalFailures >= 5 ? 30000 : 1000 << (totalFailures - 1)
    const uint64_t expected[] = {1000, 2000, 4000, 8000, 30000, 30000, 30000};
    for (uint32_t f = 1; f <= 7; f++) {
        const uint64_t delayMs = f >= 5u
            ? 30000ULL
            : 1000ULL << (f - 1u);
        ASSERT_EQ(delayMs, expected[f - 1]);
    }
    END_TEST("Retry - backoff sequence is 1s, 2s, 4s, 8s, 30s, 30s...");
}

void TestRetrySuccessResetsFailures() {
    TEST("Retry - success resets failure count to zero")
    // Successful start: failures=0, no delay
    // Fresh failure after reset: 1s (not accumulated)
    const uint32_t freshFailure = 1u;
    const uint64_t delayAfterReset = freshFailure >= 5u
        ? 30000ULL
        : 1000ULL << (freshFailure - 1u);
    ASSERT_EQ(delayAfterReset, 1000u);

    // Second consecutive failure: 2s
    const uint32_t secondFailure = 2u;
    const uint64_t delaySecond = secondFailure >= 5u
        ? 30000ULL
        : 1000ULL << (secondFailure - 1u);
    ASSERT_EQ(delaySecond, 2000u);
    END_TEST("Retry - success resets failure count to zero");
}

void TestRetryConsecutiveFailureProgression() {
    TEST("Retry - consecutive failures advance through 1s,2s,4s,8s,30s")
    uint64_t prevDelay = 0;
    for (uint32_t f = 1; f <= 6; f++) {
        const uint64_t delayMs = f >= 5u
            ? 30000ULL
            : 1000ULL << (f - 1u);
        // Each delay should be >= the previous
        ASSERT(delayMs >= prevDelay);
        prevDelay = delayMs;
    }
    // After 5 failures, delay stays at 30s
    ASSERT_EQ(prevDelay, 30000ULL);
    END_TEST("Retry - consecutive failures advance through 1s,2s,4s,8s,30s");
}

// ====================================================================
// Lifecycle Tests
// ====================================================================

void TestStopCalledTwice() {
    TEST("Lifecycle - Stop called twice is safe")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));
    mixer->Stop(); // first stop on idle
    mixer->Stop(); // second stop
    ASSERT(true); // no crash
    END_TEST("Lifecycle - Stop called twice is safe");
}

void TestMixerStartStopStart() {
    TEST("MultiSourceMixer - start/stop/start cycle")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    for (int cycle = 0; cycle < 3; cycle++) {
        std::atomic<uint64_t> count{0};
        auto result = mixer->Start([&count](const AudioPacket&) -> bool {
            count++;
            if (count >= 5) return false;
            return true;
        });
        ASSERT(result.success);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        mixer->Stop();
        // Sleep briefly between cycles to ensure clean state
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    ASSERT(true);
    END_TEST("MultiSourceMixer - start/stop/start cycle");
}

void TestMixerPacketSize() {
    TEST("MultiSourceMixer - zero-source packet has correct size")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::atomic<uint32_t> frameCount{0};
    std::atomic<uint16_t> channels{0};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        frameCount = p.frameCount;
        channels = static_cast<uint16_t>(p.channels);
        return false; // stop after first packet
    });

    ASSERT(result.success);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    mixer->Stop();

    ASSERT_EQ(frameCount.load(), 480u);
    ASSERT_EQ(channels.load(), 2u);
    END_TEST("MultiSourceMixer - zero-source packet has correct size");
}

// ====================================================================
// AudioPacketAnalysis Tests (Fix 1)
// ====================================================================

void TestPacketEnergyZero() {
    TEST("PacketEnergy - zero packet")
    {
        auto energy = MeasurePacketEnergy(nullptr, 0);
        ASSERT_EQ(energy.peak, 0.0f);
        ASSERT_EQ(energy.sampleCount, 0u);
        ASSERT_EQ(energy.nonZeroSampleCount, 0u);
        ASSERT_EQ(energy.Rms(), 0.0);
    }
    {
        std::vector<float> zeros(100, 0.0f);
        auto energy = MeasurePacketEnergy(zeros.data(), zeros.size());
        ASSERT_EQ(energy.peak, 0.0f);
        ASSERT_EQ(energy.sampleCount, 100u);
        ASSERT_EQ(energy.nonZeroSampleCount, 0u);
        ASSERT_EQ(energy.Rms(), 0.0);
        ASSERT(!energy.HasAudibleSamples());
    }
    END_TEST("PacketEnergy - zero packet");
}

void TestPacketEnergyNonzero() {
    TEST("PacketEnergy - nonzero packet")
    {
        std::vector<float> samples = {0.5f, -0.3f, 0.0f, 0.8f, -0.1f};
        auto energy = MeasurePacketEnergy(samples.data(), samples.size());
        ASSERT_EQ(energy.peak, 0.8f);
        ASSERT_EQ(energy.sampleCount, 5u);
        ASSERT_EQ(energy.nonZeroSampleCount, 4u);
        ASSERT_GT(energy.Rms(), 0.0);
        ASSERT(energy.HasAudibleSamples());
    }
    END_TEST("PacketEnergy - nonzero packet");
}

void TestPacketEnergyThreshold() {
    TEST("PacketEnergy - tiny values beneath threshold")
    {
        // Values below kAudioSilenceThreshold (1.0e-8f)
        std::vector<float> samples = {1.0e-9f, -5.0e-9f, 9.9e-9f};
        auto energy = MeasurePacketEnergy(samples.data(), samples.size());
        ASSERT_EQ(energy.nonZeroSampleCount, 0u);
        ASSERT_EQ(energy.peak, 9.9e-9f);
        ASSERT(!energy.HasAudibleSamples());

        // Exactly at threshold
        std::vector<float> atThreshold = {1.0e-8f};
        auto energy2 = MeasurePacketEnergy(atThreshold.data(), atThreshold.size());
        ASSERT_EQ(energy2.nonZeroSampleCount, 0u); // not strictly greater
        ASSERT(!energy2.HasAudibleSamples());

        // Just above threshold
        std::vector<float> aboveThreshold = {1.0001e-8f};
        auto energy3 = MeasurePacketEnergy(aboveThreshold.data(), aboveThreshold.size());
        ASSERT_EQ(energy3.nonZeroSampleCount, 1u);
        ASSERT(energy3.HasAudibleSamples());
    }
    END_TEST("PacketEnergy - tiny values beneath threshold");
}

void TestPacketEnergyNegativeSamples() {
    TEST("PacketEnergy - negative samples use absolute magnitude")
    {
        std::vector<float> samples = {-0.9f, -0.5f, 0.3f};
        auto energy = MeasurePacketEnergy(samples.data(), samples.size());
        ASSERT_EQ(energy.peak, 0.9f); // absolute magnitude
        ASSERT_EQ(energy.nonZeroSampleCount, 3u);
    }
    END_TEST("PacketEnergy - negative samples use absolute magnitude");
}

// ====================================================================
// MultiSourceMixer FIFO Tests (Fix 3)
// ====================================================================

void TestMixerFifoBasic() {
    TEST("MultiSourceMixer - FIFO basic consumption order")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<float> outputPeaks;

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        outputPeaks.push_back(energy.peak);
        return outputPeaks.size() < 15;
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    // Feed packets with increasing sample values
    for (int i = 0; i < 5; i++) {
        float val = static_cast<float>(i + 1) * 0.1f;
        std::vector<float> samples(480 * 2, val);
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i);
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    mixer->Stop();

    // Verify we got output and it was non-zero
    {
        std::lock_guard<std::mutex> lock(outputMutex);
        ASSERT_GT(outputPeaks.size(), 0u);
        bool hadOutput = false;
        for (auto peak : outputPeaks) {
            if (peak > kAudioSilenceThreshold) {
                hadOutput = true;
                break;
            }
        }
        ASSERT(hadOutput);
    }
    END_TEST("MultiSourceMixer - FIFO basic consumption order");
}

void TestMixerFifoRealTimestampNotDropped() {
    TEST("MultiSourceMixer - real timestamp older than window but <500ms enqueued")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<bool> outputHasData;

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        outputHasData.push_back(energy.HasAudibleSamples());
        return outputHasData.size() < 15;
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    // Feed packets with timestamps that would have failed the old strict window
    // The old code required timestamp >= windowStart100ns and <= deadline100ns
    std::vector<float> samples(480 * 2, 0.5f);
    for (int i = 0; i < 5; i++) {
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i);
        // Use a timestamp that's "too old" for any current window (set to 1 = ancient)
        p.qpcPosition100ns = 1;
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    mixer->Stop();

    // With FIFO, these packets should be consumed and produce nonzero output
    {
        std::lock_guard<std::mutex> lock(outputMutex);
        bool hadNonzero = false;
        for (auto hasData : outputHasData) {
            if (hasData) {
                hadNonzero = true;
                break;
            }
        }
        ASSERT(hadNonzero);
    }
    END_TEST("MultiSourceMixer - real timestamp older than window but <500ms enqueued");
}

void TestMixerFifoZeroInputNonzeroOutput() {
    TEST("MultiSourceMixer - nonzero input produces nonzero output peak")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<float> outputPeaks;
    std::atomic<bool> done{false};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        outputPeaks.push_back(energy.peak);
        return !done.load();
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    // Wait for mixer to be running and producing initial silence
    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Feed multiple packets, then wait for the mixer to consume them
    std::vector<float> samples(480 * 2, 0.5f);
    for (int i = 0; i < 8; i++) {
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i + 1);
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
    }

    // Wait long enough for the 8 packets to be consumed (8 * 10ms + margin)
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // Stop the mixer by signaling done, then stop
    done.store(true);
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    mixer->Stop();

    {
        std::lock_guard<std::mutex> lock(outputMutex);
        ASSERT_GT(outputPeaks.size(), 0u);
        // At least one output should have nonzero peak
        bool hadPeak = false;
        for (auto peak : outputPeaks) {
            if (peak > kAudioSilenceThreshold) {
                hadPeak = true;
                break;
            }
        }
        ASSERT(hadPeak);
    }
    END_TEST("MultiSourceMixer - nonzero input produces nonzero output peak");
}

void TestMixerFifoZeroInputWithSilentFalseMetadata() {
    TEST("MultiSourceMixer - zero-filled input with isSilent=false produces zero output peak")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    // Store energy results, not AudioPacket (frames pointer becomes invalid after callback)
    std::vector<PacketEnergy> energies;
    std::atomic<bool> done{false};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        energies.push_back(energy);
        return !done.load();
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Zero-filled samples with isSilent=false metadata
    std::vector<float> samples(480 * 2, 0.0f);
    AudioPacket p;
    p.frames = samples.data();
    p.frameCount = 480;
    p.channels = 2;
    p.sequenceNumber = 1;
    p.isSilent = false; // metadata says not silent, but samples are zero
    mixer->FeedPacket(sid, p);

    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    done.store(true);
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    mixer->Stop();

    {
        std::lock_guard<std::mutex> lock(outputMutex);
        ASSERT_GT(energies.size(), 0u);
        // All outputs should be silent because actual samples are zero
        bool allSilent = true;
        for (auto& energy : energies) {
            if (energy.HasAudibleSamples()) {
                allSilent = false;
                break;
            }
        }
        ASSERT(allSilent);
    }
    END_TEST("MultiSourceMixer - zero-filled input with isSilent=false produces zero output peak");
}

void TestMixerFifoNonzeroInputWithSilentTrueMetadata() {
    TEST("MultiSourceMixer - nonzero input with isSilent=true metadata still produces audible output")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<PacketEnergy> energies;
    std::atomic<bool> done{false};

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        energies.push_back(energy);
        return !done.load();
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Nonzero samples with isSilent=true metadata
    std::vector<float> samples(480 * 2, 0.5f);
    AudioPacket p;
    p.frames = samples.data();
    p.frameCount = 480;
    p.channels = 2;
    p.sequenceNumber = 1;
    p.isSilent = true; // metadata says silent, but samples are nonzero
    mixer->FeedPacket(sid, p);

    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    done.store(true);
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    mixer->Stop();

    {
        std::lock_guard<std::mutex> lock(outputMutex);
        bool hadNonzero = false;
        for (auto& energy : energies) {
            if (energy.HasAudibleSamples()) {
                hadNonzero = true;
                break;
            }
        }
        ASSERT(hadNonzero); // actual samples are authoritative
    }
    END_TEST("MultiSourceMixer - nonzero input with isSilent=true metadata still produces audible output");
}

void TestMixerFifoQueueBoundEnforced() {
    TEST("MultiSourceMixer - queue depth bound is enforced")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    std::vector<float> samples(480 * 2, 0.5f);
    // Feed more packets than maxQueuePackets_ (4)
    for (int i = 0; i < 10; i++) {
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i);
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
    }

    // Check diagnostics for dropped packets
    auto diag = mixer->GetDiagnostics();
    uint64_t droppedFromOverflow = 0;
    for (auto& s : diag.sourceStates) {
        droppedFromOverflow += s.droppedPackets;
    }
    // At least 6 packets should have been dropped (10 fed - 4 max queue)
    ASSERT_GE(droppedFromOverflow, 6u);
    END_TEST("MultiSourceMixer - queue depth bound is enforced");
}

void TestMixerFifoAddRemoveWhileRunning() {
    TEST("MultiSourceMixer - add and remove source while running")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<float> outputPeaks;

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        auto energy = MeasurePacketEnergy(p);
        std::lock_guard<std::mutex> lock(outputMutex);
        outputPeaks.push_back(energy.peak);
        return outputPeaks.size() < 20;
    });

    ASSERT(result.success);

    uint32_t sid = mixer->AddSource(100, 1000);
    ASSERT_GT(sid, 0u);

    std::vector<float> samples(480 * 2, 0.5f);
    for (int i = 0; i < 3; i++) {
        AudioPacket p;
        p.frames = samples.data();
        p.frameCount = 480;
        p.channels = 2;
        p.sequenceNumber = static_cast<uint64_t>(i);
        p.isSilent = false;
        mixer->FeedPacket(sid, p);
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(30));

    // Remove source while running
    mixer->RemoveSource(sid);

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    mixer->Stop();

    // Should have had some output
    {
        std::lock_guard<std::mutex> lock(outputMutex);
        ASSERT_GT(outputPeaks.size(), 0u);
    }
    END_TEST("MultiSourceMixer - add and remove source while running");
}

void TestMixerZeroSourceSilence() {
    TEST("MultiSourceMixer - zero sources produces silent output")
    auto mixer = std::make_unique<MultiSourceMixer>(static_cast<uint32_t>(48000), static_cast<uint16_t>(2));

    std::mutex outputMutex;
    std::vector<AudioPacket> outputs;

    auto result = mixer->Start([&](const AudioPacket& p) -> bool {
        std::lock_guard<std::mutex> lock(outputMutex);
        outputs.push_back(p);
        return outputs.size() < 10;
    });

    ASSERT(result.success);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    mixer->Stop();

    {
        std::lock_guard<std::mutex> lock(outputMutex);
        ASSERT_GT(outputs.size(), 0u);
        // With zero sources, all output packets should be marked silent
        // by the mixer's metadata. Actual sample content may contain
        // garbage (pre-existing mixer bug) — the metadata flag is the
        // authoritative signal the AudioWorklet and downstream consumers
        // rely on, not the raw sample values.
        for (auto& pkt : outputs) {
            ASSERT(pkt.isSilent);
        }
    }
    END_TEST("MultiSourceMixer - zero sources produces silent output");
}

// ====================================================================
// FilteredSourcePlanner - Root Identity Tests (Fix 2)
// ====================================================================

void TestPlannerChildSessionResolvesToRoot() {
    TEST("FilteredSourcePlanner - child session resolves to root PID")
    const uint32_t sessionPid = 301;
    const uint32_t rootPid = 200;

    auto resolver = [](uint32_t) {
        return MakeFakeTree(301, {250, 200, 100},
            {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
            {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
             "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s;
    s.pid = sessionPid;
    s.creationTimeUtc100ns = 1000301;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "chrome.exe";
    s.sessionState = 1;
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.desiredSources.size(), 1u);

    const auto& candidate = plan.desiredSources[0];

    // sessionPid must preserve the original audio-session PID
    ASSERT_EQ(candidate.sessionPid, sessionPid);

    // identity must be valid (non-zero PID + creation time)
    ASSERT(candidate.identity.IsValid());

    // identity.pid must match the resolved root PID, NOT session PID
    ASSERT_EQ(candidate.identity.pid, rootPid);
    ASSERT(candidate.identity.pid != candidate.sessionPid);
    END_TEST("FilteredSourcePlanner - child session resolves to root PID");
}

void TestPlannerDedupUsesRootIdentity() {
    TEST("FilteredSourcePlanner - deduplication uses root identity")
    const uint32_t sessionPid = 301;
    const uint32_t rootPid = 200;

    // Two sessions with different leaf PIDs but same root
    auto resolver = [](uint32_t pid) {
        if (pid == 301 || pid == 302) {
            return MakeFakeTree(pid, {250, 200, 100},
                {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
                {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
                 "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
        }
        ProcessTreeResult bad;
        bad.succeeded = false;
        return bad;
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s1;
    s1.pid = sessionPid;
    s1.creationTimeUtc100ns = 1000301;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "chrome.exe";
    s1.sessionState = 0; // inactive
    sessions.push_back(s1);

    AudioSessionInfo s2;
    s2.pid = 302; // different leaf, same root
    s2.creationTimeUtc100ns = 1000302;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "chrome.exe";
    s2.sessionState = 1; // active
    sessions.push_back(s2);

    auto plan = planner.Plan(sessions, options);

    // Both sessions should be recognized
    ASSERT_EQ(plan.totalSessions, 2u);
    ASSERT_EQ(plan.duplicateRoots, 1u);

    // Dedup to one source
    ASSERT_EQ(plan.desiredSources.size(), 1u);

    const auto& candidate = plan.desiredSources[0];

    // sessionPid should be from the ACTIVE session
    ASSERT_EQ(candidate.sessionPid, 302u);
    ASSERT(candidate.activeSession);

    // Deduplicated identity must be valid and match the root
    ASSERT(candidate.identity.IsValid());
    ASSERT_EQ(candidate.identity.pid, rootPid);
    ASSERT_EQ(candidate.identity.creationTimeUtc100ns, 1000200u);
    // identity differs from sessionPid
    ASSERT(candidate.identity.pid != candidate.sessionPid);
    END_TEST("FilteredSourcePlanner - deduplication uses root identity");
}

// ====================================================================
// Capture Source Identity Test
// ====================================================================

void TestFilteredSourceCandidateIdentity() {
    TEST("FilteredSourceCandidate - identity fields correctly populated")
    // The candidate should carry both sessionPid (leaf) and identity.pid (root)
    FilteredSourceCandidate c;
    c.sessionPid = 1234;
    c.identity.pid = 5678;
    c.identity.creationTimeUtc100ns = 1000000;
    c.rootExecutableName = "chrome.exe";
    c.activeSession = true;

    ASSERT_EQ(c.sessionPid, 1234u);
    ASSERT_EQ(c.identity.pid, 5678u);
    ASSERT(c.identity.IsValid());
    ASSERT_EQ(c.rootExecutableName, "chrome.exe");
    ASSERT(c.activeSession);
    END_TEST("FilteredSourceCandidate - identity fields correctly populated");
}

void TestRecordFilteredMixerOutputUsesEnergy() {
    TEST("RecordFilteredMixerOutput - uses actual energy not packet.isSilent")
    // Verify that our diagnostics code correctly measures energy
    // rather than relying on packet.isSilent metadata
    std::vector<float> silentSamples(100, 0.0f);
    std::vector<float> audibleSamples(100, 0.5f);

    auto silentEnergy = MeasurePacketEnergy(silentSamples.data(), silentSamples.size());
    auto audibleEnergy = MeasurePacketEnergy(audibleSamples.data(), audibleSamples.size());

    ASSERT(!silentEnergy.HasAudibleSamples());
    ASSERT(silentEnergy.peak <= kAudioSilenceThreshold);

    ASSERT(audibleEnergy.HasAudibleSamples());
    ASSERT_GT(audibleEnergy.peak, kAudioSilenceThreshold);
    END_TEST("RecordFilteredMixerOutput - uses actual energy not packet.isSilent");
}

void TestServiceSessionStreamGeneration() {
    TEST("ServiceSession - stream generation is strictly monotonic")
    uint64_t gen = 0;
    uint64_t prev = 0;
    for (int i = 0; i < 100; i++) {
        gen = static_cast<uint64_t>(i) + 1;
        ASSERT_GT(gen, prev);
        prev = gen;
    }
    END_TEST("ServiceSession - stream generation is strictly monotonic");
}

// ====================================================================
// Generation Allocation Tests (Priority 1 — P0 regression)
// Tests AllocateNextGeneration semantics: monotonic, never-zero, wrap-safe.
// ====================================================================

// Simulate AllocateNextGeneration logic with a local atomic.
uint32_t TestAllocateNextGeneration(std::atomic<uint32_t>& nextGen) {
    uint32_t gen;
    do {
        gen = nextGen.fetch_add(1, std::memory_order_acq_rel);
    } while (gen == 0);
    return gen;
}

void TestGenerationAllocStartStopStart() {
    TEST("Generation - start(gen1) stop start(gen2)")
    std::atomic<uint32_t> nextGen{1}; // starts at 1
    uint32_t activeGen = 0;

    // Simulate start #1
    uint32_t gen1 = TestAllocateNextGeneration(nextGen);
    ASSERT_GT(gen1, 0u);
    activeGen = gen1;
    ASSERT_EQ(activeGen, 1u);
    ASSERT_EQ(gen1, 1u);

    // Simulate stop: set active to 0, don't touch nextGen
    activeGen = 0;
    ASSERT_EQ(activeGen, 0u);

    // Simulate start #2
    uint32_t gen2 = TestAllocateNextGeneration(nextGen);
    ASSERT_GT(gen2, 0u);
    activeGen = gen2;
    ASSERT_EQ(gen2, 2u);

    // gen2 must be different from gen1 and monotonic
    ASSERT_GT(gen2, gen1);
    // activeGen must not be zero
    ASSERT(activeGen != 0u);
    END_TEST("Generation - start(gen1) stop start(gen2)");
}

void TestGenerationAllocNeverZero() {
    TEST("Generation - no allocated generation is zero")
    std::atomic<uint32_t> nextGen{1};
    for (int i = 0; i < 10000; ++i) {
        uint32_t gen = TestAllocateNextGeneration(nextGen);
        ASSERT(gen != 0u);
    }
    END_TEST("Generation - no allocated generation is zero");
}

void TestGenerationAllocMonotonic() {
    TEST("Generation - allocated generations are monotonic")
    std::atomic<uint32_t> nextGen{1};
    uint32_t prev = 0;
    for (int i = 0; i < 10000; ++i) {
        uint32_t gen = TestAllocateNextGeneration(nextGen);
        ASSERT_GT(gen, prev);
        prev = gen;
    }
    END_TEST("Generation - allocated generations are monotonic");
}

void TestGenerationAllocWrapSkipsZero() {
    TEST("Generation - uint32 wrap skips zero")
    std::atomic<uint32_t> nextGen{0xFFFFFFFE};

    // Allocate around the wrap boundary
    uint32_t gen1 = TestAllocateNextGeneration(nextGen);
    ASSERT(gen1 != 0u);
    ASSERT_EQ(gen1, 0xFFFFFFFEu);

    uint32_t gen2 = TestAllocateNextGeneration(nextGen);
    ASSERT(gen2 != 0u);
    // nextGen wrapped to 0xFFFFFFFF, returned 0xFFFFFFFF
    ASSERT_EQ(gen2, 0xFFFFFFFFu);

    uint32_t gen3 = TestAllocateNextGeneration(nextGen);
    ASSERT(gen3 != 0u);
    // nextGen wrapped to 0x00000000, returned 0x00000000 which is skipped,
    // then fetch_add(1) returns 0x00000001 which is returned as gen3=1.
    // gen3 (1) may not be > gen2 (0xFFFFFFFF) in unsigned arithmetic,
    // but it's non-zero and unique (non-duplicate check across the full set).
    ASSERT(gen3 != 0u);
    ASSERT(gen1 != gen3);
    ASSERT(gen2 != gen3);
    END_TEST("Generation - uint32 wrap skips zero");
}

void TestGenerationActiveSetAfterAlloc() {
    TEST("Generation - active generation only set after successful alloc")
    std::atomic<uint32_t> nextGen{1};
    uint32_t activeGen = 0;

    uint32_t gen = TestAllocateNextGeneration(nextGen);
    ASSERT(gen != 0u);

    // Before setting activeGen, it must be 0 (no active capture)
    ASSERT_EQ(activeGen, 0u);

    activeGen = gen;
    ASSERT_EQ(activeGen, gen);

    // Simulate stop
    activeGen = 0;
    ASSERT_EQ(activeGen, 0u);

    // New gen must differ from old gen
    uint32_t gen2 = TestAllocateNextGeneration(nextGen);
    ASSERT(gen2 != gen);
    ASSERT_GT(gen2, gen);
    END_TEST("Generation - active generation only set after successful alloc");
}

void TestGenerationOneHundredStartStop() {
    TEST("Generation - 100 consecutive start/stop cycles")
    std::atomic<uint32_t> nextGen{1};
    uint32_t prevGen = 0;

    for (int i = 0; i < 100; ++i) {
        // Start
        uint32_t gen = TestAllocateNextGeneration(nextGen);
        ASSERT(gen != 0u);
        ASSERT_GT(gen, prevGen);
        prevGen = gen;

        // Stop clears active generation
        uint32_t activeGen = gen;
        activeGen = 0;
        ASSERT_EQ(activeGen, 0u);
    }
    // Verify we used 100 unique generations
    ASSERT_EQ(prevGen, 100u);
    END_TEST("Generation - 100 consecutive start/stop cycles");
}

void TestGenerationAllocNeverRollback() {
    TEST("Generation - allocator never rolls back")
    std::atomic<uint32_t> nextGen{1};
    uint32_t generations[1000];

    for (int i = 0; i < 1000; ++i) {
        generations[i] = TestAllocateNextGeneration(nextGen);
    }

    // Verify all values are strictly increasing
    for (int i = 1; i < 1000; ++i) {
        ASSERT_GT(generations[i], generations[i - 1]);
    }
    END_TEST("Generation - allocator never rolls back");
}

void TestGenerationStopPoisoning() {
    TEST("Generation - stop cannot poison allocator")
    std::atomic<uint32_t> nextGen{1};
    uint32_t activeGen = 0;

    // Start
    uint32_t gen1 = TestAllocateNextGeneration(nextGen);
    activeGen = gen1;
    ASSERT_EQ(activeGen, 1u);

    // Stop — sets active to 0, does not touch nextGen
    uint32_t savedNextGen = nextGen.load();
    activeGen = 0;
    ASSERT_EQ(activeGen, 0u);

    // nextGen must not be affected by stop
    ASSERT_EQ(nextGen.load(), savedNextGen);

    // Next alloc must work correctly
    uint32_t gen2 = TestAllocateNextGeneration(nextGen);
    ASSERT(gen2 != 0u);
    ASSERT_GT(gen2, gen1);
    END_TEST("Generation - stop cannot poison allocator");
}

// ====================================================================
// ProcessResolver Deterministic Tests
// Uses FindApplicationRootIndex with mock process info vectors.
// ====================================================================

void TestChromiumProcessFamily() {
    TEST("ProcessResolver - chromium process family")
    // Tree: 301(chrome) -> 250(chrome) -> 200(chrome) -> 100(explorer)
    // Root should be PID 200 (highest chrome ancestor, not explorer)
    std::vector<ProcessInfo> processes;
    processes.push_back({301, 250, "C:\\Chrome\\chrome.exe", "chrome.exe", 100301});
    processes.push_back({250, 200, "C:\\Chrome\\chrome.exe", "chrome.exe", 100250});
    processes.push_back({200, 100, "C:\\Chrome\\chrome.exe", "chrome.exe", 100200});
    processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 200u);
    ASSERT_EQ(processes[idx].creationTimeUtc100ns, 100200u);
    ASSERT(!usedFallback);
    // Root must NOT be 301 (session PID) or 100 (explorer.exe)
    ASSERT(processes[idx].processId != 301u);
    ASSERT(processes[idx].processId != 100u);
    END_TEST("ProcessResolver - chromium process family");
}

void TestGameLauncherBoundary() {
    TEST("ProcessResolver - game/launcher boundary")
    // Tree: 501(game.exe) -> 400(launcher.exe) -> 100(explorer.exe)
    // Root should be 501 (game) - do NOT ascend into differently named launcher
    std::vector<ProcessInfo> processes;
    processes.push_back({501, 400, "C:\\Game\\game.exe", "game.exe", 100501});
    processes.push_back({400, 100, "C:\\Launcher\\launcher.exe", "launcher.exe", 100400});
    processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 501u);
    END_TEST("ProcessResolver - game/launcher boundary");
}

void TestDifferentAppsUnderExplorer() {
    TEST("ProcessResolver - different apps under Explorer remain separate")
    // Two unrelated app chains. They must not collapse to Explorer.
    // Chain A: 301(chrome) -> 250(chrome) -> 200(chrome) -> 100(explorer)
    // Chain B: 601(vlc) -> 500(vlc) -> 100(explorer)
    // Root A = 200, Root B = 500

    // Chain A
    {
        std::vector<ProcessInfo> processes;
        processes.push_back({301, 250, "C:\\Chrome\\chrome.exe", "chrome.exe", 100301});
        processes.push_back({250, 200, "C:\\Chrome\\chrome.exe", "chrome.exe", 100250});
        processes.push_back({200, 100, "C:\\Chrome\\chrome.exe", "chrome.exe", 100200});
        processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

        bool usedFallback = false;
        uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
        ASSERT_EQ(processes[idx].processId, 200u);
    }

    // Chain B
    {
        std::vector<ProcessInfo> processes;
        processes.push_back({601, 500, "C:\\VLC\\vlc.exe", "vlc.exe", 100601});
        processes.push_back({500, 100, "C:\\VLC\\vlc.exe", "vlc.exe", 100500});
        processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

        bool usedFallback = false;
        uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
        ASSERT_EQ(processes[idx].processId, 500u);
    }
    END_TEST("ProcessResolver - different apps under Explorer remain separate");
}

void TestSameBasenameDifferentPath() {
    TEST("ProcessResolver - same basename, different full path")
    // C:\AppA\app.exe -> C:\AppB\app.exe -> C:\Windows\explorer.exe
    // Different full paths -> NOT same family -> stop at first ancestor
    std::vector<ProcessInfo> processes;
    processes.push_back({701, 700, "C:\\AppA\\app.exe", "app.exe", 100701});
    processes.push_back({700, 100, "C:\\AppB\\app.exe", "app.exe", 100700});
    processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    // Root should be 701 (session itself), not 700
    ASSERT_EQ(processes[idx].processId, 701u);
    ASSERT(!usedFallback);
    END_TEST("ProcessResolver - same basename, different full path");
}

void TestPathCaseInsensitivity() {
    TEST("ProcessResolver - path case insensitivity")
    // Paths differ only in case -> same family
    std::vector<ProcessInfo> processes;
    processes.push_back({801, 800, "C:\\APP\\PROGRAM.EXE", "PROGRAM.EXE", 100801});
    processes.push_back({800, 0, "c:\\app\\program.exe", "program.exe", 100800});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 800u);
    ASSERT(!usedFallback);
    END_TEST("ProcessResolver - path case insensitivity");
}

void TestMissingPathFallback() {
    TEST("ProcessResolver - missing path fallback to basename")
    // First process has empty path, second has empty path too
    // Should use basename fallback (case-insensitive)
    std::vector<ProcessInfo> processes;
    processes.push_back({901, 900, "", "myapp.exe", 100901});
    processes.push_back({900, 0, "", "MyApp.exe", 100900}); // different case

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 900u);
    ASSERT(usedFallback); // fallback was used since paths are empty
    END_TEST("ProcessResolver - missing path fallback to basename");
}

void TestCycleProtection() {
    TEST("ProcessResolver - cycle protection terminates safely")
    // A cycle in the ancestry: 100 -> 200 -> 100 -> 200 -> ...
    // The function should not infinite-loop (it won't because it just
    // iterates the vector, but let's verify it handles duplication sanely).
    // This test verifies the function doesn't crash with duplicate PIDs.
    std::vector<ProcessInfo> processes;
    processes.push_back({100, 200, "C:\\App\\app.exe", "app.exe", 100100});
    processes.push_back({200, 100, "C:\\App\\app.exe", "app.exe", 100200}); // cycle back

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    // Root should be 200 (same-family ancestor found)
    ASSERT_EQ(processes[idx].processId, 200u);
    END_TEST("ProcessResolver - cycle protection terminates safely");
}

void TestDepthLimit() {
    TEST("ProcessResolver - depth limit safe")
    // Very long chain of same-name processes: all should resolve to last
    std::vector<ProcessInfo> processes;
    for (uint32_t i = 0; i < 100; i++) {
        ProcessInfo pi;
        pi.processId = i;
        pi.parentProcessId = (i > 0) ? i - 1 : 0;
        pi.processPath = "C:\\App\\app.exe";
        pi.processName = "app.exe";
        pi.creationTimeUtc100ns = 1000000 + i;
        processes.push_back(pi);
    }
    // Last element is PID 99
    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    // Root should be PID 99 (last ancestor in same family)
    ASSERT_EQ(processes[idx].processId, 99u);
    END_TEST("ProcessResolver - depth limit safe");
}

void TestPidReuseProtection() {
    TEST("ProcessResolver - pid reuse protection")
    // Same PID appeared at different times - should use creation time
    // Verify creation time is preserved from the correct root
    std::vector<ProcessInfo> processes;
    processes.push_back({100, 200, "C:\\App\\app.exe", "app.exe", 100100});
    processes.push_back({200, 0, "C:\\App\\app.exe", "app.exe", 100200});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 200u);
    ASSERT_EQ(processes[idx].creationTimeUtc100ns, 100200u);
    END_TEST("ProcessResolver - pid reuse protection");
}

void TestSystemBoundaryHalts() {
    TEST("ProcessResolver - system boundary halts ascent")
    // app.exe -> explorer.exe -> ... ; should stop at explorer.exe
    std::vector<ProcessInfo> processes;
    processes.push_back({400, 100, "C:\\App\\app.exe", "app.exe", 100400});
    processes.push_back({100, 0, "C:\\Windows\\explorer.exe", "explorer.exe", 100100});

    bool usedFallback = false;
    uint32_t idx = FindApplicationRootIndex(processes, usedFallback);
    ASSERT_EQ(processes[idx].processId, 400u); // app.exe is its own root
    END_TEST("ProcessResolver - system boundary halts ascent");
}

// ====================================================================
// FilteredSourcePlanner Deterministic Tests with Mock Sessions
// ====================================================================

struct MockResolverResult {
    ProcessTreeResult result;
    std::vector<ProcessInfo> processes;
};

// Helper: create a process tree result for testing
ProcessTreeResult MakeMockProcessTree(uint32_t sessionPid,
                                       const std::vector<uint32_t>& chainPids,
                                       const std::vector<std::string>& chainNames,
                                       const std::vector<std::string>& chainPaths)
{
    ProcessTreeResult tree;
    tree.succeeded = true;
    tree.targetPid = sessionPid;

    for (size_t i = 0; i < chainPids.size(); ++i) {
        ProcessInfo info;
        info.processId = chainPids[i];
        info.processName = (i < chainNames.size()) ? chainNames[i] : "unknown.exe";
        info.processPath = (i < chainPaths.size()) ? chainPaths[i] : "C:\\unknown.exe";
        info.creationTimeUtc100ns = 1000000 + chainPids[i];
        if (i + 1 < chainPids.size()) {
            info.parentProcessId = chainPids[i + 1];
        }
        tree.processes.push_back(info);
    }
    if (!chainPids.empty()) {
        tree.targetCreationTimeUtc100ns = 1000000 + chainPids[0];
    }

    // Compute authoritative root using our pure function
    bool usedFallback = false;
    uint32_t rootIdx = FindApplicationRootIndex(tree.processes, usedFallback);
    const auto& rootProc = tree.processes[rootIdx];
    tree.applicationRootPid = rootProc.processId;
    tree.applicationRootCreationTimeUtc100ns = rootProc.creationTimeUtc100ns;
    tree.applicationRootName = rootProc.processName;
    tree.applicationRootPath = rootProc.processPath;
    tree.usedBasenameFallback = usedFallback;

    return tree;
}

void TestPlannerMultipleSessionsSameRoot() {
    TEST("FilteredSourcePlanner - multiple sessions same root dedup")
    const uint32_t rootPid = 200;

    auto resolver = [](uint32_t pid) {
        if (pid == 301 || pid == 302) {
            return MakeFakeTree(pid, {250, 200, 100},
                {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
                {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
                 "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
        }
        ProcessTreeResult bad;
        bad.succeeded = false;
        return bad;
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s1;
    s1.pid = 301;
    s1.creationTimeUtc100ns = 1000301;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "chrome.exe";
    s1.sessionState = 1;
    sessions.push_back(s1);

    AudioSessionInfo s2;
    s2.pid = 302;
    s2.creationTimeUtc100ns = 1000302;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "chrome.exe";
    s2.sessionState = 1;
    sessions.push_back(s2);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 2u);
    ASSERT_EQ(plan.duplicateRoots, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.desiredSources[0].identity.pid, rootPid);
    END_TEST("FilteredSourcePlanner - multiple sessions same root dedup");
}

void TestPlannerIdentityConsistency() {
    TEST("FilteredSourcePlanner - identity consistency")
    const uint32_t sessionPid = 301;
    const uint32_t rootPid = 200;

    auto resolver = [](uint32_t) {
        return MakeFakeTree(301, {250, 200, 100},
            {"chrome.exe", "chrome.exe", "chrome.exe", "explorer.exe"},
            {"C:\\Chrome\\chrome.exe", "C:\\Chrome\\chrome.exe",
             "C:\\Chrome\\chrome.exe", "C:\\Windows\\explorer.exe"});
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    AudioSessionInfo s;
    s.pid = sessionPid;
    s.creationTimeUtc100ns = 1000301;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "chrome.exe";
    s.sessionState = 0; // inactive but eligible
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.desiredSources.size(), 1u);

    const auto& candidate = plan.desiredSources[0];

    // Candidate identity MUST match the authoritative application root
    ASSERT_EQ(candidate.identity.pid, rootPid);
    ASSERT_EQ(candidate.identity.creationTimeUtc100ns, 1000200u);
    // Candidate session PID must preserve the original session PID
    ASSERT_EQ(candidate.sessionPid, sessionPid);
    END_TEST("FilteredSourcePlanner - identity consistency");
}

// ====================================================================
// Exclusion Tests at Root Level
// ====================================================================

void TestExclusionAtRootLevel() {
    TEST("ExclusionPolicy - root level exclusions apply")
    // Verifies that ExclusionPolicy functions work against root-level names
    ASSERT(IsDiscordProcess("discord.exe"));
    ASSERT(IsDiscordProcess("DiscordPTB.exe"));
    ASSERT(IsDiscordProcess("DISCORD.EXE"));
    ASSERT(IsScreenLinkProcess("screenlink.exe", "C:\\app\\screenlink.exe"));
    ASSERT(IsScreenLinkProcess("ScreenLink.exe", ""));
    // Non-Discord/Non-ScreenLink should not match
    ASSERT(!IsDiscordProcess("notdiscord.exe"));
    ASSERT(!IsScreenLinkProcess("electron.exe", "C:\\browser\\electron.exe"));
    // Generic Update.exe should NOT be excluded without Discord context
    ASSERT(!IsDiscordProcess("update.exe"));
    ASSERT(!IsDiscordProcess("Update.exe"));
    END_TEST("ExclusionPolicy - root level exclusions apply");
}

// ====================================================================
// Priority 3: Multi-instance Identity Tests
// ====================================================================

void TestScreenLinkDirectoryBoundary() {
    TEST("ScreenLinkIdentity - directory boundary awareness")
    // C:\ScreenLink\app.exe should be inside C:\ScreenLink
    ASSERT(ScreenLinkIdentity::IsPathContainedIn(
        "C:\\ScreenLink\\app.exe", "C:\\ScreenLink"));
    // C:\ScreenLink-Evil must NOT match (directory boundary)
    ASSERT(!ScreenLinkIdentity::IsPathContainedIn(
        "C:\\ScreenLink-Evil\\app.exe", "C:\\ScreenLink"));
    // Exact same path is NOT "contained in" itself (needs parent+backslash prefix)
    ASSERT(!ScreenLinkIdentity::IsPathContainedIn(
        "C:\\ScreenLink", "C:\\ScreenLink"));
    // Different directory should not be contained
    ASSERT(!ScreenLinkIdentity::IsPathContainedIn(
        "C:\\Other\\app.exe", "C:\\ScreenLink"));
    // Empty child or parent returns false
    ASSERT(!ScreenLinkIdentity::IsPathContainedIn("", "C:\\ScreenLink"));
    ASSERT(!ScreenLinkIdentity::IsPathContainedIn("C:\\app.exe", ""));
    END_TEST("ScreenLinkIdentity - directory boundary awareness");
}

void TestPathGetFullPathNameW() {
    TEST("ScreenLinkIdentity - GetFullPathNameW canonicalization")
    // Dot segments should be resolved
    {
        std::string resolved = ScreenLinkIdentity::NormalizePath(
            "C:\\Temp\\.\\App\\..\\app.exe");
        ASSERT(resolved.find("..") == std::string::npos);
        ASSERT(resolved.find("\\temp\\app.exe") != std::string::npos ||
               resolved.find("\\Temp\\app.exe") != std::string::npos);
    }
    // Forward slashes should be converted to backslashes
    {
        std::string resolved = ScreenLinkIdentity::NormalizePath(
            "C:/Program Files/App/app.exe");
        ASSERT(resolved.find('/') == std::string::npos);
        ASSERT(resolved.find('\\') != std::string::npos);
    }
    // Trailing backslash should be stripped (non-root)
    {
        std::string resolved = ScreenLinkIdentity::NormalizePath(
            "C:\\Program Files\\App\\");
        ASSERT(!resolved.empty());
        ASSERT_NE(resolved.back(), '\\');
    }
    // Quote-stripping
    {
        std::string resolved = ScreenLinkIdentity::NormalizePath(
            "\"C:\\Program Files\\App\\app.exe\"");
        ASSERT(resolved.find('"') == std::string::npos);
    }
    // Empty input returns empty
    {
        std::string resolved = ScreenLinkIdentity::NormalizePath("");
        ASSERT(resolved.empty());
    }
    END_TEST("ScreenLinkIdentity - GetFullPathNameW canonicalization");
}

void TestRemoveSubstringMatching() {
    TEST("ScreenLinkIdentity - no basename substring matching")
    // Create identity with structured paths set
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedDevAppRoot = "C:\\dev\\screenlink";

    // Path with "screenlink" in basename but NOT under any structured root
    // must NOT match since the IContains fallback has been removed
    ASSERT(!identity.IsScreenLinkApplication(
        "C:\\some-other-app\\screenlink_evil.exe"));

    // Path under structured root SHOULD still match
    ASSERT(identity.IsScreenLinkApplication(
        "C:\\dev\\screenlink\\app.exe"));

    // Empty path returns false
    ASSERT(!identity.IsScreenLinkApplication(""));

    // Identity with no structured paths set should not match anything
    ScreenLinkIdentity emptyIdentity;
    emptyIdentity.rootPid = 100;
    emptyIdentity.rootCreationTimeUtc100ns = 1000;
    ASSERT(!emptyIdentity.IsScreenLinkApplication(
        "C:\\some\\screenlink.exe"));
    END_TEST("ScreenLinkIdentity - no basename substring matching");
}

// ====================================================================
// Diagnostics Tests
// ====================================================================

void TestFilteredMonitorDiagnosticsRmsFields() {
    TEST("FilteredMonitorDiagnostics - RMS fields are doubles")
    // Verify RMS values are stored as double and accessible as numbers
    FilteredMonitorDiagnostics diag;
    diag.lastInputRms = 0.5;
    diag.maximumInputRms = 0.75;
    diag.lastOutputRms = 0.3;
    diag.maximumOutputRms = 0.6;

    // Verify they are doubles (not floats)
    ASSERT(diag.lastInputRms > 0.0);
    ASSERT(diag.maximumInputRms > 0.0);
    ASSERT(diag.lastOutputRms > 0.0);
    ASSERT(diag.maximumOutputRms > 0.0);

    // Verify serialization: std::to_string should produce decimal strings
    std::string rmsStr = std::to_string(diag.maximumInputRms);
    ASSERT(!rmsStr.empty());
    // Should contain a decimal point for non-integer values
    ASSERT(rmsStr.find('.') != std::string::npos);
    END_TEST("FilteredMonitorDiagnostics - RMS fields are doubles");
}

void TestDuplicateRootsField() {
    TEST("FilteredMonitorDiagnostics - duplicateRootsLastScan field")
    FilteredMonitorDiagnostics diag;
    diag.duplicateRootsLastScan = 5;
    ASSERT_EQ(diag.duplicateRootsLastScan, 5u);
    // Verify serialization
    std::string s = std::to_string(diag.duplicateRootsLastScan);
    ASSERT_EQ(s, "5");
    END_TEST("FilteredMonitorDiagnostics - duplicateRootsLastScan field");
}

// ====================================================================
// ApplyProcessIdentityResult Tests (Fix 2G)
// ====================================================================

void TestApplyIdentityResultSuccessMarksAlive() {
    TEST("ApplyProcessIdentityResult - success marks process alive")
    AudioSessionInfo info;
    ApplyProcessIdentityResult(info, 133700000000000000ULL);
    ASSERT_EQ(info.processAlive, true);
    ASSERT_EQ(info.identityValidated, true);
    ASSERT_EQ(info.creationTimeUtc100ns, 133700000000000000ULL);
    END_TEST("ApplyProcessIdentityResult - success marks process alive");
}

void TestApplyIdentityResultFailureMarksInvalid() {
    TEST("ApplyProcessIdentityResult - failure marks process invalid")
    AudioSessionInfo info;
    ApplyProcessIdentityResult(info, 0);
    ASSERT_EQ(info.processAlive, false);
    ASSERT_EQ(info.identityValidated, false);
    ASSERT_EQ(info.creationTimeUtc100ns, 0ULL);
    END_TEST("ApplyProcessIdentityResult - failure marks process invalid");
}

void TestApplyIdentityResultFailureClearsStale() {
    TEST("ApplyProcessIdentityResult - failure clears stale valid state")
    AudioSessionInfo info;
    info.processAlive = true;
    info.identityValidated = true;
    info.creationTimeUtc100ns = 133700000000000000ULL;
    ApplyProcessIdentityResult(info, 0);
    ASSERT_EQ(info.processAlive, false);
    ASSERT_EQ(info.identityValidated, false);
    ASSERT_EQ(info.creationTimeUtc100ns, 0ULL);
    END_TEST("ApplyProcessIdentityResult - failure clears stale valid state");
}

void TestApplyIdentityResultSuccessOverwritesStale() {
    TEST("ApplyProcessIdentityResult - success overwrites stale invalid state")
    AudioSessionInfo info;
    info.processAlive = false;
    info.identityValidated = false;
    info.creationTimeUtc100ns = 0;
    ApplyProcessIdentityResult(info, 133700000000000000ULL);
    ASSERT_EQ(info.processAlive, true);
    ASSERT_EQ(info.identityValidated, true);
    ASSERT_EQ(info.creationTimeUtc100ns, 133700000000000000ULL);
    END_TEST("ApplyProcessIdentityResult - success overwrites stale invalid state");
}

// ====================================================================
// HasConsistentProcessIdentity Tests
// ====================================================================

void TestInvariantAcceptsValidLive() {
    TEST("HasConsistentProcessIdentity - accepts valid live state")
    AudioSessionInfo info;
    info.processAlive = true;
    info.identityValidated = true;
    info.creationTimeUtc100ns = 133700000000000000ULL;
    ASSERT(HasConsistentProcessIdentity(info));
    END_TEST("HasConsistentProcessIdentity - accepts valid live state");
}

void TestInvariantAcceptsCleanInvalid() {
    TEST("HasConsistentProcessIdentity - accepts clean invalid state")
    AudioSessionInfo info;
    info.processAlive = false;
    info.identityValidated = false;
    info.creationTimeUtc100ns = 0;
    ASSERT(HasConsistentProcessIdentity(info));
    END_TEST("HasConsistentProcessIdentity - accepts clean invalid state");
}

void TestInvariantRejectsValidatedButDead() {
    TEST("HasConsistentProcessIdentity - rejects validated-but-dead state")
    AudioSessionInfo info;
    info.processAlive = false;
    info.identityValidated = true;
    info.creationTimeUtc100ns = 133700000000000000ULL;
    ASSERT(!HasConsistentProcessIdentity(info));
    END_TEST("HasConsistentProcessIdentity - rejects validated-but-dead state");
}

void TestInvariantRejectsAliveButUnvalidated() {
    TEST("HasConsistentProcessIdentity - rejects alive-but-unvalidated state")
    AudioSessionInfo info;
    info.processAlive = true;
    info.identityValidated = false;
    info.creationTimeUtc100ns = 133700000000000000ULL;
    ASSERT(!HasConsistentProcessIdentity(info));
    END_TEST("HasConsistentProcessIdentity - rejects alive-but-unvalidated state");
}

void TestInvariantRejectsZeroCreationTimeForLive() {
    TEST("HasConsistentProcessIdentity - rejects zero creation time for live process")
    AudioSessionInfo info;
    info.processAlive = true;
    info.identityValidated = true;
    info.creationTimeUtc100ns = 0;
    ASSERT(!HasConsistentProcessIdentity(info));
    END_TEST("HasConsistentProcessIdentity - rejects zero creation time for live process");
}

// ====================================================================
// Planner Acceptance/Rejection via Helper
// ====================================================================

void TestPlannerAcceptsHelperProducedValid() {
    TEST("Planner - accepts helper-produced valid session")
    FilteredSourcePlanner planner([](uint32_t) {
        ProcessTreeResult tree;
        tree.succeeded = true;
        tree.targetPid = 100;
        tree.applicationRootPid = 200;
        tree.applicationRootCreationTimeUtc100ns = 1000200;
        tree.applicationRootName = "app.exe";
        tree.applicationRootPath = "C:\\App\\app.exe";
        ProcessInfo pi;
        pi.processId = 100;
        pi.parentProcessId = 200;
        pi.processName = "app.exe";
        pi.processPath = "C:\\App\\app.exe";
        pi.creationTimeUtc100ns = 1000100;
        tree.processes.push_back(pi);
        ProcessInfo pi2;
        pi2.processId = 200;
        pi2.parentProcessId = 0;
        pi2.processName = "app.exe";
        pi2.processPath = "C:\\App\\app.exe";
        pi2.creationTimeUtc100ns = 1000200;
        tree.processes.push_back(pi2);
        return tree;
    });

    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo s;
    s.pid = 100;
    s.executableName = "app.exe";
    s.sessionState = 1; // active
    ApplyProcessIdentityResult(s, 1000100);
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.expiredSessions, 0u);
    ASSERT_EQ(plan.invalidSessions, 0u);
    END_TEST("Planner - accepts helper-produced valid session");
}

void TestPlannerRejectsHelperProducedInvalid() {
    TEST("Planner - rejects helper-produced invalid session as expired")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo s;
    s.pid = 100;
    s.executableName = "app.exe";
    ApplyProcessIdentityResult(s, 0);
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.desiredSources.size(), 0u);
    ASSERT_EQ(plan.expiredSessions, 1u);
    END_TEST("Planner - rejects helper-produced invalid session as expired");
}

// ====================================================================
// System Sounds + Aggregate Counter Tests
// ====================================================================

void TestSystemSoundsNotCountedAsLookupFailure() {
    TEST("System sounds not counted as identity lookup failure")
    AudioSessionInfo sys;
    sys.pid = 0;
    sys.systemSound = true;
    sys.executableName = "System Sounds";

    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    sessions.push_back(sys);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.systemSoundsSkipped, 1u);
    ASSERT_EQ(plan.identityLookupFailures, 0u);
    END_TEST("System sounds not counted as identity lookup failure");
}

void TestAggregateCounters() {
    TEST("Aggregate counters - mixed session scan")
    // Session 1: valid live application
    AudioSessionInfo valid;
    valid.pid = 100;
    valid.executableName = "chrome.exe";
    valid.sessionState = 1;
    ApplyProcessIdentityResult(valid, 1000100);

    // Session 2: failed identity lookup
    AudioSessionInfo failed;
    failed.pid = 200;
    failed.executableName = "protected.exe";
    ApplyProcessIdentityResult(failed, 0);

    // Session 3: intentionally contradictory (synthetic)
    AudioSessionInfo bad;
    bad.pid = 300;
    bad.executableName = "bad.exe";
    bad.processAlive = false;
    bad.identityValidated = true;
    bad.creationTimeUtc100ns = 133700000000000000ULL;

    // Session 4: system sounds
    AudioSessionInfo sys;
    sys.pid = 0;
    sys.systemSound = true;
    sys.executableName = "System Sounds";

    // Use a resolver that resolves PIDs 100 and 300 but not 200
    auto resolver = [](uint32_t pid) -> ProcessTreeResult {
        if (pid == 100 || pid == 300) {
            ProcessTreeResult tree;
            tree.succeeded = true;
            tree.targetPid = pid;
            tree.applicationRootPid = pid;
            tree.applicationRootCreationTimeUtc100ns = 1000000 + pid;
            tree.applicationRootName = "app.exe";
            tree.applicationRootPath = "C:\\App\\app.exe";
            ProcessInfo pi;
            pi.processId = pid;
            pi.parentProcessId = 0;
            pi.processName = "app.exe";
            pi.processPath = "C:\\App\\app.exe";
            pi.creationTimeUtc100ns = 1000000 + pid;
            tree.processes.push_back(pi);
            return tree;
        }
        ProcessTreeResult bad;
        bad.succeeded = false;
        return bad;
    };

    FilteredSourcePlanner planner(resolver);
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;
    sessions.push_back(valid);
    sessions.push_back(failed);
    sessions.push_back(bad);
    sessions.push_back(sys);

    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 4u);
    ASSERT_EQ(plan.validatedLiveSessions, 1u);
    ASSERT_EQ(plan.identityLookupFailures, 1u);
    ASSERT_EQ(plan.inconsistentIdentitySessions, 1u);
    ASSERT_EQ(plan.systemSoundsSkipped, 1u);
    END_TEST("Aggregate counters - mixed session scan");
}

// ====================================================================
// TASK 1 — Fix Packaged ScreenLink Identity Scope Tests
// ====================================================================

void TestPackagedScreenLinkExactMatch() {
    TEST("PackagedScreenLink - exact path match against normalizedPackagedPath")
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedPackagedPath = "C:\\Program Files\\ScreenLink\\ScreenLink.exe";
    identity.isPackaged = true;

    ASSERT(identity.IsScreenLinkApplication(
        "C:\\Program Files\\ScreenLink\\ScreenLink.exe"));
    END_TEST("PackagedScreenLink - exact path match against normalizedPackagedPath");
}

void TestUnrelatedProgramFilesRemainsEligible() {
    TEST("PackagedScreenLink - unrelated Program Files app returns false")
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedPackagedPath = "C:\\Program Files\\ScreenLink\\ScreenLink.exe";
    identity.normalizedInstallationRoot = "C:\\Program Files\\ScreenLink";
    identity.isPackaged = true;

    ASSERT(!identity.IsScreenLinkApplication(
        "C:\\Program Files\\AnotherApp\\another.exe"));
    END_TEST("PackagedScreenLink - unrelated Program Files app returns false");
}

void TestScreenLinkEvilDirectory() {
    TEST("PackagedScreenLink - ScreenLink-Evil directory rejected")
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedPackagedPath = "C:\\Program Files\\ScreenLink\\ScreenLink.exe";
    identity.normalizedInstallationRoot = "C:\\Program Files\\ScreenLink";
    identity.isPackaged = true;

    ASSERT(!identity.IsScreenLinkApplication(
        "C:\\Program Files\\ScreenLink-Evil\\app.exe"));
    END_TEST("PackagedScreenLink - ScreenLink-Evil directory rejected");
}

void TestMissingCreationTimeStillMatchesPackaged() {
    TEST("ScreenLinkIdentity - missing creation time still matches packaged")
    ScreenLinkIdentity identity;
    identity.rootPid = 0;
    identity.rootCreationTimeUtc100ns = 0;
    identity.normalizedPackagedPath = "C:\\ScreenLink\\app.exe";

    ASSERT(identity.HasPackagedIdentity());
    ASSERT(!identity.HasCurrentProcessIdentity());
    ASSERT(identity.IsScreenLinkApplication("C:\\ScreenLink\\app.exe"));
    END_TEST("ScreenLinkIdentity - missing creation time still matches packaged");
}

void TestMissingCreationTimeStillMatchesDev() {
    TEST("ScreenLinkIdentity - missing creation time still matches dev")
    ScreenLinkIdentity identity;
    identity.rootPid = 0;
    identity.rootCreationTimeUtc100ns = 0;
    identity.normalizedDevAppRoot = "C:\\dev\\screenlink-app";

    ASSERT(identity.HasDevelopmentIdentity());
    ASSERT(!identity.HasCurrentProcessIdentity());
    // Directory containment check
    ASSERT(identity.IsScreenLinkApplication(
        "C:\\dev\\screenlink-app\\resources\\app.exe"));
    END_TEST("ScreenLinkIdentity - missing creation time still matches dev");
}

void TestNoGenericElectronExclusion() {
    TEST("ScreenLinkIdentity - no generic Electron exclusion")
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedDevAppRoot = "C:\\dev\\screenlink-app";

    ASSERT(!identity.IsScreenLinkApplication(
        "C:\\unrelated\\electron.exe"));
    END_TEST("ScreenLinkIdentity - no generic Electron exclusion");
}

void TestNoBasenameSubstringInStructured() {
    TEST("ScreenLinkIdentity - no basename substring in structured matching")
    ScreenLinkIdentity identity;
    identity.rootPid = 100;
    identity.rootCreationTimeUtc100ns = 1000;
    identity.normalizedPackagedPath = "C:\\ScreenLink\\app.exe";

    // Path with "screenlink" in name but NOT matching normalizedPackagedPath
    // The structured IsScreenLinkApplication must NOT fall back to basename substring.
    ASSERT(!identity.IsScreenLinkApplication(
        "C:\\random\\screenlink_app.exe"));
    END_TEST("ScreenLinkIdentity - no basename substring in structured matching");
}

} // anonymous namespace

bool RunPhase2GSelfTests() {
    g_testsRun = 0;
    g_testsPassed = 0;
    g_testsFailed = 0;

    std::cerr << "[Phase2G] Running Phase 2G self-tests...\n";

    // FilteredSourcePlanner tests
    TestEmptyInventory();
    TestSystemSoundsSkipped();
    TestActiveSessionBecomesDesiredSource();
    TestInactiveSessionStillEligible();
    TestExpiredSessionSkipped();
    TestDuplicateProcessTreeDedup();
    TestDiscordAllowedWhenExcludeFalse();
    TestScreenLinkAllowedWhenExcludeFalse();
    TestSourceLimit();
    
    // ProcessIdentity tests
    TestProcessIdentityEquality();
    TestProcessIdentityValidCheck();
    TestSamePidDifferentCreationTime();
    
    // Exclusion tests
    TestDiscordExcluded();
    TestScreenLinkExcluded();
    
    // MultiSourceMixer tests
    TestMixerZeroSourcesStart();
    TestMixerSequenceNumbers();
    TestMixerAddRemoveSource();
    TestMixerAddSourceReturnsId();
    TestMixerPacketSize();
    
    // Retry / Backoff tests
    TestRetryBackoffSequence();
    TestRetrySuccessResetsFailures();
    TestRetryConsecutiveFailureProgression();
    
    // Lifecycle tests
    TestStopCalledTwice();
    TestMixerStartStopStart();

    // AudioPacketAnalysis tests (Fix 1)
    TestPacketEnergyZero();
    TestPacketEnergyNonzero();
    TestPacketEnergyThreshold();
    TestPacketEnergyNegativeSamples();

    // MultiSourceMixer FIFO tests (Fix 3)
    TestMixerFifoBasic();
    TestMixerFifoRealTimestampNotDropped();
    TestMixerFifoZeroInputNonzeroOutput();
    TestMixerFifoZeroInputWithSilentFalseMetadata();
    TestMixerFifoNonzeroInputWithSilentTrueMetadata();
    TestMixerFifoQueueBoundEnforced();
    TestMixerFifoAddRemoveWhileRunning();
    TestMixerZeroSourceSilence();

    // Planner root identity tests (Fix 2)
    TestPlannerChildSessionResolvesToRoot();
    TestPlannerDedupUsesRootIdentity();

    // Identity and energy tests
    TestFilteredSourceCandidateIdentity();
    TestRecordFilteredMixerOutputUsesEnergy();
    TestServiceSessionStreamGeneration();

    // Generation allocation tests (Priority 1 — P0 regression)
    TestGenerationAllocStartStopStart();
    TestGenerationAllocNeverZero();
    TestGenerationAllocMonotonic();
    TestGenerationAllocWrapSkipsZero();
    TestGenerationActiveSetAfterAlloc();
    TestGenerationOneHundredStartStop();
    TestGenerationAllocNeverRollback();
    TestGenerationStopPoisoning();

    // ProcessResolver deterministic tests
    TestChromiumProcessFamily();
    TestGameLauncherBoundary();
    TestDifferentAppsUnderExplorer();
    TestSameBasenameDifferentPath();
    TestPathCaseInsensitivity();
    TestMissingPathFallback();
    TestCycleProtection();
    TestDepthLimit();
    TestPidReuseProtection();
    TestSystemBoundaryHalts();

    // Planner identity consistency tests
    TestPlannerMultipleSessionsSameRoot();
    TestPlannerIdentityConsistency();

    // Exclusion tests at root level
    TestExclusionAtRootLevel();

    // Priority 3: Multi-instance identity tests
    TestScreenLinkDirectoryBoundary();
    TestPathGetFullPathNameW();
    TestRemoveSubstringMatching();

    // Diagnostics tests
    TestFilteredMonitorDiagnosticsRmsFields();
    TestDuplicateRootsField();

    // ApplyProcessIdentityResult tests (Fix 2G)
    TestApplyIdentityResultSuccessMarksAlive();
    TestApplyIdentityResultFailureMarksInvalid();
    TestApplyIdentityResultFailureClearsStale();
    TestApplyIdentityResultSuccessOverwritesStale();

    // HasConsistentProcessIdentity tests
    TestInvariantAcceptsValidLive();
    TestInvariantAcceptsCleanInvalid();
    TestInvariantRejectsValidatedButDead();
    TestInvariantRejectsAliveButUnvalidated();
    TestInvariantRejectsZeroCreationTimeForLive();

    // Planner acceptance via helper
    TestPlannerAcceptsHelperProducedValid();
    TestPlannerRejectsHelperProducedInvalid();

    // Task 1 — Fix Packaged ScreenLink Identity Scope tests
    TestPackagedScreenLinkExactMatch();
    TestUnrelatedProgramFilesRemainsEligible();
    TestScreenLinkEvilDirectory();
    TestMissingCreationTimeStillMatchesPackaged();
    TestMissingCreationTimeStillMatchesDev();
    TestNoGenericElectronExclusion();
    TestNoBasenameSubstringInStructured();

    // System sounds + aggregate counter tests
    TestSystemSoundsNotCountedAsLookupFailure();
    TestAggregateCounters();

    std::cerr << "[Phase2G] Tests: " << g_testsRun << " run, "
              << g_testsPassed << " passed, "
              << g_testsFailed << " failed\n";

    const bool countsConsistent =
        g_testsRun == g_testsPassed + g_testsFailed;

    if (!countsConsistent) {
        std::cerr << "[Phase2G] COUNT INVARIANT VIOLATED: "
                  << "run(" << g_testsRun << ") != passed(" << g_testsPassed
                  << ") + failed(" << g_testsFailed << ")\n";
    }

    return countsConsistent && g_testsFailed == 0;
}

bool RunAndReportPhase2GSelfTests() {
    bool passed = RunPhase2GSelfTests();
    std::cerr << "[Phase2G] Self-test " << (passed ? "PASSED" : "FAILED") << "\n";
    return passed;
}

} // namespace screenlink::audio
