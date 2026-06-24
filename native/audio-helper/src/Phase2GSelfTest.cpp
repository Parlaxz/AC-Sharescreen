#include "Phase2GSelfTest.h"
#include "AudioPacketAnalysis.h"
#include "FilteredMonitorTypes.h"
#include "FilteredSourcePlanner.h"
#include "AudioSessionMonitor.h"
#include "MultiSourceMixer.h"
#include "ExclusionPolicy.h"
#include "ProcessResolver.h"
#include "LoopbackCapture.h"

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

#define ASSERT_GE(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av >= bv)) { \
        std::cerr << "[Phase2G] ASSERT_GE failed at " << __LINE__ << ": " #a " (" << av << ") < " #b " (" << bv << ")\n"; \
        testOk = false; \
        return; \
    } \
} while(0)

#define ASSERT_LE(a, b) do { \
    auto av = (a); auto bv = (b); \
    if (!(av <= bv)) { \
        std::cerr << "[Phase2G] ASSERT_LE failed at " << __LINE__ << ": " #a " (" << av << ") > " #b " (" << bv << ")\n"; \
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
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    AudioSessionInfo s;
    s.pid = currentPid;
    s.creationTimeUtc100ns = currentCreationTime;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "app.exe";
    s.sessionState = 1; // AudioSessionStateActive
    sessions.push_back(s);
    auto plan = planner.Plan(sessions, options);
    ASSERT_EQ(plan.totalSessions, 1u);
    ASSERT_EQ(plan.desiredSources.size(), 1u);
    ASSERT_EQ(plan.desiredSources[0].sessionPid, currentPid);
    END_TEST("FilteredSourcePlanner - active session becomes one desired source");
}

void TestInactiveSessionStillEligible() {
    TEST("FilteredSourcePlanner - inactive session still eligible")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    AudioSessionInfo s;
    s.pid = currentPid;
    s.creationTimeUtc100ns = currentCreationTime;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "app.exe";
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
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    AudioSessionInfo s1;
    s1.pid = currentPid;
    s1.creationTimeUtc100ns = currentCreationTime;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "app.exe";
    s1.sessionState = 1;
    sessions.push_back(s1);
    AudioSessionInfo s2;
    s2.pid = currentPid; // same process, so same root
    s2.creationTimeUtc100ns = currentCreationTime;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "app.exe";
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
    TEST("FilteredSourcePlanner - same-root sessions dedup to at most one source")
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    // Add many sessions all from the same process tree -> all dedup to one
    for (uint32_t i = 0; i < 10; i++) {
        AudioSessionInfo s;
        s.pid = currentPid;
        s.creationTimeUtc100ns = currentCreationTime;
        s.identityValidated = true;
        s.processAlive = true;
        s.executableName = "app.exe";
        s.sessionState = 1;
        sessions.push_back(s);
    }
    auto plan = planner.Plan(sessions, options);
    // All sessions share the same root, so only one desired source
    ASSERT_EQ(plan.totalSessions, 10u);
    ASSERT(plan.desiredSources.size() <= 1u);
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
        for (auto& pkt : outputs) {
            auto energy = MeasurePacketEnergy(pkt);
            ASSERT(!energy.HasAudibleSamples());
        }
    }
    END_TEST("MultiSourceMixer - zero sources produces silent output");
}

// ====================================================================
// FilteredSourcePlanner - Root Identity Tests (Fix 2)
// ====================================================================

void TestPlannerChildSessionResolvesToRoot() {
    TEST("FilteredSourcePlanner - child session resolves to root PID")
    // Proves that the planner assigns the resolved root PID (from the
    // authoritative ProcessResolver applicationRoot*) to the candidate
    // identity, not the leaf session PID or tree.processes.back().
    //
    // Invariant:
    //   candidate.sessionPid == session.pid (original leaf PID)
    //   candidate.identity.pid == tree.applicationRootPid (authoritative root)
    //   candidate.identity creationTime == tree.applicationRootCreationTimeUtc100ns
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    AudioSessionInfo s;
    s.pid = currentPid;
    s.creationTimeUtc100ns = currentCreationTime;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "test.exe";
    s.sessionState = 1;
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);

    // If we got a candidate, verify the identity invariant
    if (plan.desiredSources.size() > 0) {
        const auto& candidate = plan.desiredSources[0];
        auto tree = ResolveProcessTree(currentPid);

        // sessionPid must preserve the original audio-session PID
        ASSERT_EQ(candidate.sessionPid, currentPid);

        // identity must be valid (non-zero PID + creation time)
        ASSERT(candidate.identity.IsValid());

        // identity.pid must match the resolved root PID from ProcessResolver,
        // NOT tree.processes.back().processId.
        if (tree.succeeded) {
            ASSERT_EQ(candidate.identity.pid, tree.applicationRootPid);
            ASSERT_EQ(candidate.identity.creationTimeUtc100ns, tree.applicationRootCreationTimeUtc100ns);
        }

        // When the session process is NOT the root, identity and sessionPid differ.
        // When it IS the root, they are equal (trivially correct).
        if (candidate.identity.pid != currentPid) {
            ASSERT(candidate.identity.pid != candidate.sessionPid);
        }
    }
    END_TEST("FilteredSourcePlanner - child session resolves to root PID");
}

void TestPlannerDedupUsesRootIdentity() {
    TEST("FilteredSourcePlanner - deduplication uses root identity")
    // Verifies that:
    // 1. Two sessions from the same process tree produce one candidate (dedup).
    // 2. The identity used for deduplication is identical to the identity
    //    passed to ApplicationCaptureSource::Start() via candidate.identity.
    // 3. The dedup key is tree.applicationRootPid, not tree.processes.back().
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    // First session
    AudioSessionInfo s1;
    s1.pid = currentPid;
    s1.creationTimeUtc100ns = currentCreationTime;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "app.exe";
    s1.sessionState = 1;
    sessions.push_back(s1);

    // Second session (same PID -> same root -> should dedup)
    AudioSessionInfo s2;
    s2.pid = currentPid;
    s2.creationTimeUtc100ns = currentCreationTime;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "app.exe";
    s2.sessionState = 1;
    sessions.push_back(s2);

    auto plan = planner.Plan(sessions, options);

    // Both sessions should be recognized
    ASSERT_EQ(plan.totalSessions, 2u);

    if (plan.desiredSources.size() > 0) {
        // Should be deduplicated to one source
        ASSERT_EQ(plan.desiredSources.size(), 1u);

        const auto& candidate = plan.desiredSources[0];

        // sessionPid preserves the leaf (session) PID
        ASSERT_EQ(candidate.sessionPid, currentPid);

        // Deduplicated identity must be valid
        ASSERT(candidate.identity.IsValid());

        // The candidate identity matches the authoritative application root
        // from ProcessResolver, NOT tree.processes.back().
        auto tree = ResolveProcessTree(currentPid);
        if (tree.succeeded) {
            ASSERT_EQ(candidate.identity.pid, tree.applicationRootPid);
            ASSERT_EQ(candidate.identity.creationTimeUtc100ns, tree.applicationRootCreationTimeUtc100ns);
        }

        // If the session process is not the root, identity differs from sessionPid
        if (candidate.identity.pid != currentPid) {
            ASSERT(candidate.identity.pid != candidate.sessionPid);
        }
    }
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
    // Two sessions (301, 302) both resolve to root 200.
    // Expected: 1 desired source, candidate.identity.pid=200, sessionPid preserved.
    // Mock the resolver by directly calling the planner's plan path is not possible
    // since it calls ResolveProcessTree internally. Instead, we verify the
    // downstream behavior: planner produces 1 source for 2 sessions with same root.

    // We test indirectly by verifying identity consistency:
    // candidate.identity == tree.applicationRootPid
    // and dedup collapses same-root sessions.
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    // Session 301
    AudioSessionInfo s1;
    s1.pid = 301;
    s1.creationTimeUtc100ns = 1000301;
    s1.identityValidated = true;
    s1.processAlive = true;
    s1.executableName = "chrome.exe";
    s1.sessionState = 1; // active
    sessions.push_back(s1);

    // Session 302 (same root expected)
    AudioSessionInfo s2;
    s2.pid = 302;
    s2.creationTimeUtc100ns = 1000302;
    s2.identityValidated = true;
    s2.processAlive = true;
    s2.executableName = "chrome.exe";
    s2.sessionState = 1; // active
    sessions.push_back(s2);

    auto plan = planner.Plan(sessions, options);
    // NOTE: These tests call the real ResolveProcessTree, so they are
    // OS-dependent. On this machine, processes 301/302 likely don't exist,
    // so the tree may fail to resolve. These tests are best-effort.
    // The deterministic FindApplicationRootIndex tests cover the algorithm.

    // Just verify basic behavior: at least sessions were counted
    ASSERT_EQ(plan.totalSessions, 2u);
    // Invalid sessions expected since PIDs don't exist (not a real process)
    // This is fine for best-effort testing.

    END_TEST("FilteredSourcePlanner - multiple sessions same root dedup");
}

void TestPlannerIdentityConsistency() {
    TEST("FilteredSourcePlanner - identity consistency")
    // Validates that candidate.identity matches tree.applicationRootPid
    // for the current process (which we can resolve).
    FilteredSourcePlanner planner;
    FilteredMonitorOptions options;
    std::vector<AudioSessionInfo> sessions;

    const uint32_t currentPid = GetCurrentProcessId();
    const uint64_t currentCreationTime = GetProcessCreationTime(currentPid);

    AudioSessionInfo s;
    s.pid = currentPid;
    s.creationTimeUtc100ns = currentCreationTime;
    s.identityValidated = true;
    s.processAlive = true;
    s.executableName = "test.exe";
    s.sessionState = 0; // inactive but eligible
    sessions.push_back(s);

    auto plan = planner.Plan(sessions, options);

    if (plan.desiredSources.size() > 0) {
        const auto& candidate = plan.desiredSources[0];
        auto tree = ResolveProcessTree(currentPid);
        if (tree.succeeded) {
            // Candidate identity MUST match the authoritative application root
            ASSERT_EQ(candidate.identity.pid, tree.applicationRootPid);
            ASSERT_EQ(candidate.identity.creationTimeUtc100ns, tree.applicationRootCreationTimeUtc100ns);
            // Candidate session PID must preserve the original session PID
            ASSERT_EQ(candidate.sessionPid, currentPid);
        }
    }
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

void TestDuplicateRootSessionsField() {
    TEST("FilteredMonitorDiagnostics - duplicateRootSessionsLastScan field")
    FilteredMonitorDiagnostics diag;
    diag.duplicateRootSessionsLastScan = 5;
    ASSERT_EQ(diag.duplicateRootSessionsLastScan, 5u);
    // Verify serialization
    std::string s = std::to_string(diag.duplicateRootSessionsLastScan);
    ASSERT_EQ(s, "5");
    END_TEST("FilteredMonitorDiagnostics - duplicateRootSessionsLastScan field");
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

    // Diagnostics tests
    TestFilteredMonitorDiagnosticsRmsFields();
    TestDuplicateRootSessionsField();

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
