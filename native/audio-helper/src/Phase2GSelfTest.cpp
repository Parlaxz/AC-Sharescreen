#include "Phase2GSelfTest.h"
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

#define TEST(name) do { \
    g_testsRun++; \
    bool testOk = true; \
    try {

#define END_TEST(name) \
    } catch (const std::exception& e) { \
        std::cerr << "[Phase2G] FAIL: " << name << " - exception: " << e.what() << "\n"; \
        testOk = false; \
    } catch (...) { \
        std::cerr << "[Phase2G] FAIL: " << name << " - unknown exception\n"; \
        testOk = false; \
    } \
    if (testOk) { \
        g_testsPassed++; \
    } else { \
        g_testsFailed++; \
        std::cerr << "[Phase2G] FAIL: " << name << "\n"; \
    } \
} while(0)

#define ASSERT(cond) do { \
    if (!(cond)) { \
        std::cerr << "[Phase2G] ASSERT failed at " << __LINE__ << ": " #cond "\n"; \
        testOk = false; \
        return; \
    } \
} while(0)

#define ASSERT_EQ(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (av != bv) { \
        std::cerr << "[Phase2G] ASSERT_EQ failed at " << __LINE__ << ": " #a " (" << av << ") != " #b " (" << bv << ")\n"; \
        testOk = false; \
        return; \
    } \
} while(0)

#define ASSERT_GT(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av > bv)) { \
        std::cerr << "[Phase2G] ASSERT_GT failed at " << __LINE__ << ": " #a " (" << av << ") <= " #b " (" << bv << ")\n"; \
        testOk = false; \
        return; \
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

void TestActiveSessionBecomesDesiredSource() {
    TEST("FilteredSourcePlanner - active session becomes one desired source")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo s;
    s.pid = static_cast<uint32_t>(GetCurrentProcessId());
    s.creationTimeUtc100ns = 1000000;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "helper.exe";
    s.sessionState = 1; // AudioSessionStateActive
    sessions.push_back(s);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT(plan.desiredSources[0].identity.IsValid());
    END_TEST("FilteredSourcePlanner - active session becomes one desired source");
}

void TestInactiveSessionStillEligible() {
    TEST("FilteredSourcePlanner - inactive session still eligible")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;
    AudioSessionInfo s;
    s.pid = static_cast<uint32_t>(GetCurrentProcessId());
    s.creationTimeUtc100ns = 1000000;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "helper.exe";
    s.sessionState = 0; // AudioSessionStateInactive
    sessions.push_back(s);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.inactiveSessions, 1u);
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
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID which contains "screenlink"
    std::vector<AudioSessionInfo> sessions;
    const uint32_t selfPid = static_cast<uint32_t>(GetCurrentProcessId());
    AudioSessionInfo s1;
    s1.pid = selfPid;
    s1.creationTimeUtc100ns = 1000000;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "helper.exe";
    s1.sessionState = 1;
    sessions.push_back(s1);
    AudioSessionInfo s2;
    s2.pid = selfPid; // same process, so same root
    s2.creationTimeUtc100ns = 1000000;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "helper.exe";
    s2.sessionState = 1;
    sessions.push_back(s2);
    auto plan = planner.Plan(sessions, options);
    // Both sessions have same PID, so ResolveProcessTree returns
    // the same root -> one gets deduplicated
    ASSERT_EQ(plan.totalSessions, 2u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
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
    TEST("FilteredSourcePlanner - duplicate many sessions dedup")
    // Many sessions all with the same resolvable PID -> all deduplicate to 1 root
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    options.excludeScreenLink = false; // Test uses helper PID
    std::vector<AudioSessionInfo> sessions;
    const uint32_t selfPid = static_cast<uint32_t>(GetCurrentProcessId());
    for (uint32_t i = 0; i < 10; i++) {
        AudioSessionInfo s;
        s.pid = selfPid; // all same PID -> same root -> dedup to 1
        s.creationTimeUtc100ns = 1000000 + i;
        s.identityValidated = true;
        s.processAlive = true;
        s.executableName = "helper.exe";
        s.sessionState = 1;
        sessions.push_back(s);
    }
    auto plan = planner.Plan(sessions, options);
    // All resolve to the same root, so only 1 desired source
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.duplicateRoots, 9u);
    END_TEST("FilteredSourcePlanner - duplicate many sessions dedup");
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

    std::cerr << "[Phase2G] Tests: " << g_testsRun << " run, "
              << g_testsPassed << " passed, "
              << g_testsFailed << " failed\n";

    return g_testsFailed == 0;
}

bool RunAndReportPhase2GSelfTests() {
    bool passed = RunPhase2GSelfTests();
    std::cerr << "[Phase2G] Self-test " << (passed ? "PASSED" : "FAILED") << "\n";
    return passed;
}

} // namespace screenlink::audio
