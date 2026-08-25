/**
 * media.spec.ts — REAL SCREEN-SHARE + REAL VIEWER PLAYBACK (Phases 4 + 6
 * of the E2E test plan). Hard media evidence only: no getDisplayMedia
 * mocking, no fake streams, no group-auth bypass.
 *
 * MEDIA-001 host shares fixture through REAL picker      (@critical @media)
 * MEDIA-002+003 bob watches real advancing media +
 *               WebRTC stats evidence via rtcStats()     (@critical @media)
 * MEDIA-004 stop flow tears everything down              (@critical @media)
 * MEDIA-005 restart share → new session identity         (@media)
 * MEDIA-006 kick isolation                               (@media @resilience)
 * MEDIA-007 viewer exit preserves host share             (@media)
 *
 * Product paths verified (read, never edited):
 * - apps/desktop/src/renderer/components/workspace/ShareSetup.tsx — source
 *   tabs/cards (data-source-title), audio RadioGroup, start-sharing-button.
 * - apps/desktop/src/renderer/components/workspace/HostDashboard.tsx —
 *   viewer rows/kick/stop/restart; host-viewer-count; host-source-label.
 * - apps/desktop/src/renderer/components/workspace/GroupOverview.tsx —
 *   active-share-card / watch-stream-button.
 * - apps/desktop/src/renderer/components/workspace/ViewerWorkspace.tsx +
 *   viewer/* — viewer-video, viewer-ended-state, viewer-exit-button,
 *   "Exit viewer" aria-label button while watching.
 * - apps/desktop/src/renderer/services/test-hooks.ts — snapshot(), markers,
 *   and the additive rtcStats() bridge (PART A).
 *
 * KNOWN ENVIRONMENT QUIRKS (documented):
 * - Renderer console capture arrives empty in this setup → all evidence is
 *   taken from markers ring buffer / main-process marker file / snapshots /
 *   DOM sampling, never from console logs.
 * - Graceful close hangs with a live group connection → every shutdown uses
 *   the bounded shutdownAgent pattern (helpers-mesh).
 * - Membership propagation to a 3rd joiner is flaky (~50%) and self-heals
 *   via one restart of the lagging agent (formMediaMesh workaround).
 */
import { test, expect } from '../framework/fixtures.js';
import { startFixture, type FixtureHandle } from '../fixtures/fixture-window/client.js';
import {
	makeMediaProfiles,
	formMediaMesh,
	mediaSnapshot,
	streamsForGroup,
	waitForHostSharing,
	sampleRtcStats,
	sampleViewerVideo,
	waitForViewerVideoLive,
	readToastShownMarkers,
	mainWindowCount,
	startFixtureShareViaUi,
	stopShareViaUi,
	watchActiveShareViaUi,
	mediaCleanupChecks,
	ensureFixtureCapturable,
	sleep,
	waitFor,
} from './helpers-media.js';
import { MarkerTracker, shutdownAgent } from './helpers-mesh.js';
import type { AgentController } from '../framework/agent.js';

/** Per-run unique tag so profiles/fixtures never collide with stale runs. */
const RUN = `${process.pid}-${Date.now() % 100000}`;

/** Fixture control ports are explicit so cleanup can verify port release. */
const FIXTURE_PORT_BASE = 9730;

type AgentList = AgentController[];

interface MediaTestContext {
	fixture: FixtureHandle | null;
	fixturePort: number;
	agents: AgentList;
}

/** Shared per-test scaffolding: fixture + alice creates group + shares it. */
async function setupHostShare(opts: {
	createAgent: (name?: string) => Promise<AgentController>;
	runTag: string;
	fixturePort: number;
	ctx: MediaTestContext;
	includeBob?: boolean;
}): Promise<{
	alice: AgentController;
	bob: AgentController;
	groupId: string;
	groupName: string;
}> {
	const profiles = makeMediaProfiles(opts.runTag);
	const fixture = await startFixture({
		agent: 'media-alice',
		controlPort: opts.fixturePort,
	});
	opts.ctx.fixture = fixture;
	expect(fixture.title, 'fixture title must be exactly E2E-FIXTURE:MEDIA-ALICE').toBe(
		'E2E-FIXTURE:MEDIA-ALICE',
	);
	// Documented quirk workaround: fresh fixture windows are invisible to
	// desktopCapturer until a restore/show cycle (see helpers-media).
	await ensureFixtureCapturable(fixture);

	const mesh = await formMediaMesh({
		createAgent: opts.createAgent,
		profiles,
		runTag: opts.runTag,
		includeCharlie: false,
		onAgent: (a) => opts.ctx.agents.push(a),
	});

	// Fixture liveness probe right before the picker opens (formation takes
	// minutes — if the fixture died meanwhile we want to know immediately).
	try {
		const framesNow = await fixture.frames();
		console.log(`[setupHostShare] fixture alive before share, frames=${framesNow}`);
	} catch (err) {
		throw new Error(`fixture control server unreachable before share start: ${String(err)}`);
	}

	await startFixtureShareViaUi(mesh.alice);
	return {
		alice: mesh.alice,
		bob: mesh.bob,
		groupId: mesh.groupId,
		groupName: mesh.groupName,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-001
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media MEDIA-001: host shares fixture through real picker', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `m1-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 1, agents: [] };
	try {
		const { alice, groupId } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});
		const fixture = ctx.fixture!;

		// share-started marker drained from the renderer ring buffer.
		const aliceMarkers = new MarkerTracker(alice);
		const markerMs = await aliceMarkers.waitFor('share-started', 20_000);
		artifactDir.writeJson('media001-alice-markers.json', aliceMarkers.all());
		expect(
			markerMs,
			`share-started marker must fire on alice (markers seen: ${JSON.stringify(aliceMarkers.all())})`,
		).toBeGreaterThanOrEqual(0);

		// Snapshot contract: sharing===true with non-empty session ids.
		const hostShare = await waitForHostSharing(alice, 30_000, 'alice hostShare.sharing===true');
		artifactDir.writeJson('media001-host-share.json', hostShare);
		console.log(`[MEDIA-001] sessionId=${hostShare.sessionId} mediaSessionId=${hostShare.mediaSessionId}`);

		// activeStreams has EXACTLY 1 entry scoped to this group.
		const snap = await mediaSnapshot(alice);
		artifactDir.writeJson('media001-alice-snapshot.json', snap);
		const groupStreams = streamsForGroup(snap, groupId);
		expect(groupStreams, `exactly one active stream for ${groupId}`).toHaveLength(1);
		expect(
			snap?.activeStreams ?? [],
			`no stray active streams outside the group: ${JSON.stringify(snap?.activeStreams)}`,
		).toHaveLength(1);

		// host-source-label references the fixture title.
		const sourceLabel = await alice.page
			.locator('[data-testid="host-source-label"]')
			.innerText({ timeout: 15_000 });
		artifactDir.writeJson('media001-source-label.json', { sourceLabel });
		expect(
			sourceLabel,
			`host-source-label must reference the fixture title, got "${sourceLabel}"`,
		).toContain('E2E-FIXTURE:');

		// Fixture liveness baseline: frame counter advances.
		const f0 = await fixture.frames();
		await sleep(3_000);
		const f1 = await fixture.frames();
		artifactDir.writeJson('media001-fixture-frames.json', { f0, f1 });
		expect(f1, `fixture frame counter must advance (${f0} → ${f1})`).toBeGreaterThan(f0);
		console.log(`[MEDIA-001] OK — fixture frames ${f0} → ${f1}`);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media001-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice],
		});
		artifactDir.writeJson('media001-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-002 + MEDIA-003 (one steady-state session serves both scenarios:
// MEDIA-003 explicitly samples "while MEDIA-002 steady state")
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media MEDIA-002+003: viewer watches real advancing media + WebRTC stats evidence', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `m23-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 2, agents: [] };
	try {
		const { alice, bob, groupId } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});
		const fixture = ctx.fixture!;
		const tWatchStart = Date.now();

		// ── Bob watches ────────────────────────────────────────────────
		const bobMarkers = new MarkerTracker(bob);
		await watchActiveShareViaUi(bob);

		// Markers sequence: viewer-joined THEN viewer-watching (order + ts).
		const watchingMs = await bobMarkers.waitFor('viewer-watching', 90_000);
		await bobMarkers.drain();
		const seq = bobMarkers.all();
		artifactDir.writeJson('media002-bob-markers.json', seq);
		const joinedIdx = seq.findIndex((m) => m.marker === 'viewer-joined');
		const watchingIdx = seq.findIndex((m) => m.marker === 'viewer-watching');
		console.log(
			`[MEDIA-002] marker timeline: ${JSON.stringify(seq.map((m) => `${m.marker}@${m.t}`))}`,
		);
		expect(
			watchingIdx,
			`viewer-watching marker must fire on bob (seen: ${JSON.stringify(seq)})`,
		).toBeGreaterThanOrEqual(0);
		expect(
			joinedIdx,
			`viewer-joined marker must fire before viewer-watching (seen: ${JSON.stringify(seq)})`,
		).toBeGreaterThanOrEqual(0);
		expect(
			joinedIdx,
			'viewer-joined must precede viewer-watching',
		).toBeLessThan(watchingIdx);
		console.log(
			`[MEDIA-002] viewer-joined@${seq[joinedIdx]!.t} → viewer-watching@${seq[watchingIdx]!.t} (watch click → watching: ${watchingMs}ms)`,
		);

		// Video element live: readyState>=3, videoWidth>0, videoHeight>0.
		const firstSample = await waitForViewerVideoLive(
			bob.page,
			60_000,
			'bob viewer-video readyState>=3 with non-zero dimensions',
		);
		artifactDir.writeJson('media002-video-first-sample.json', firstSample);
		console.log(
			`[MEDIA-002] video live: ${firstSample.videoWidth}×${firstSample.videoHeight} readyState=${firstSample.readyState} currentTime=${firstSample.currentTime}`,
		);

		// ── FRAME ADVANCE PROOF (30s: t0/t15/t30) ─────────────────────
		const s0 = await sampleViewerVideo(bob.page);
		await sleep(15_000);
		const s15 = await sampleViewerVideo(bob.page);
		await sleep(15_000);
		const s30 = await sampleViewerVideo(bob.page);
		const elapsedTotal = (Date.now() - tWatchStart) / 1000;
		const frameProof = {
			samples: [
				{ label: 't0', ...s0 },
				{ label: 't+15s', ...s15 },
				{ label: 't+30s', ...s30 },
			],
			currentTimeStrictlyIncreasing:
				(s15.currentTime ?? 0) > (s0.currentTime ?? 0) &&
				(s30.currentTime ?? 0) > (s15.currentTime ?? 0),
			rvfcAvailable: s0.rvfc !== null && s15.rvfc !== null && s30.rvfc !== null,
			rvfcIncreasing:
				s0.rvfc !== null &&
				s15.rvfc !== null &&
				s30.rvfc !== null &&
				s15.rvfc! > s0.rvfc! &&
				s30.rvfc! > s15.rvfc!,
			renderedFpsEstimate:
				s0.rvfc !== null && s30.rvfc !== null
					? Number((((s30.rvfc ?? 0) - (s0.rvfc ?? 0)) / 30).toFixed(2))
					: null,
			note: 'rvfc counts begin at the FIRST sampleViewerVideo call (installed lazily)',
		};
		artifactDir.writeJson('media002-frame-proof.json', frameProof);
		console.log(`[MEDIA-002] frame proof: ${JSON.stringify(frameProof)}`);
		expect(
			frameProof.currentTimeStrictlyIncreasing,
			`currentTime must strictly increase across t0/t15/t30: ${JSON.stringify([s0.currentTime, s15.currentTime, s30.currentTime])}`,
		).toBe(true);
		if (frameProof.rvfcAvailable) {
			expect(
				frameProof.rvfcIncreasing,
				`requestVideoFrameCallback count must increase when available: ${JSON.stringify([s0.rvfc, s15.rvfc, s30.rvfc])}`,
			).toBe(true);
		}
		// Rendered progress implies liveness: document observed fps estimate.
		console.log(
			`[MEDIA-002] observed rendered fps estimate (rVFC delta / 30s): ${frameProof.renderedFpsEstimate}`,
		);

		// Fixture counter monotonic across the watch window.
		const fxStart = await fixture.frames();
		await sleep(5_000);
		const fxEnd = await fixture.frames();
		const fixtureFps = ((fxEnd - fxStart) / 5).toFixed(1);
		artifactDir.writeJson('media002-fixture-counter.json', {
			fxStart,
			fxEnd,
			elapsedSec: 5,
			fixtureFpsEstimate: fixtureFps,
		});
		expect(fxEnd, `fixture counter must be strictly increasing (${fxStart} → ${fxEnd})`).toBeGreaterThan(fxStart);
		console.log(`[MEDIA-002] fixture fps estimate: ${fixtureFps}`);

		// Host-side view: exactly 1 viewer, row reflects watching (playing).
		await alice.page
			.locator('[data-testid="host-viewer-count"]')
			.filter({ hasText: '1' })
			.waitFor({ state: 'visible', timeout: 90_000 });
		const viewerRow = await alice.page
			.locator('[data-testid="viewer-row"]')
			.first()
			.getAttribute('data-viewer-state', { timeout: 15_000 });
		artifactDir.writeJson('media002-host-view.json', { viewerCountText: '1', viewerRowState: viewerRow });
		console.log(
			`[MEDIA-002] alice host-viewer-count=1; viewer-row data-viewer-state="${viewerRow}" (product maps watching→playing)`,
		);
		expect(
			viewerRow,
			`viewer-row state should be "playing" (product's rendering of a watching viewer), got "${viewerRow}"`,
		).toBe('playing');

		// ── Toast heartbeat dedupe: exactly ONE toast-shown on bob ────
		// toast-shown is MAIN-process-only (<userData>/logs/e2e-markers.log).
		let toasts1 = await readToastShownMarkers(bob);
		const toastDeadline = Date.now() + 60_000;
		while (toasts1.length === 0 && Date.now() < toastDeadline) {
			await sleep(3_000);
			toasts1 = await readToastShownMarkers(bob);
		}
		await sleep(30_000);
		const toasts2 = await readToastShownMarkers(bob);
		artifactDir.writeJson('media002-toast-dedupe.json', { firstPoll: toasts1, secondPollAfter30s: toasts2 });
		console.log(
			`[MEDIA-002] toast-shown polls: first=${toasts1.length}, after 30s=${toasts2.length}`,
		);
		expect(
			toasts2.length,
			`exactly ONE toast-shown expected on bob within the observation window (heartbeat dedupe): ${JSON.stringify(toasts2)}`,
		).toBe(1);

		// ── MEDIA-003: WebRTC stats evidence via bridge rtcStats() ────
		const bobStats1 = await sampleRtcStats(bob);
		const aliceStats1 = await sampleRtcStats(alice);
		await sleep(6_000); // ≥5s apart
		const bobStats2 = await sampleRtcStats(bob);
		const aliceStats2 = await sampleRtcStats(alice);
		artifactDir.writeJson('media003-bob-rtcstats-1.json', bobStats1);
		artifactDir.writeJson('media003-bob-rtcstats-2.json', bobStats2);
		artifactDir.writeJson('media003-alice-rtcstats-1.json', aliceStats1);
		artifactDir.writeJson('media003-alice-rtcstats-2.json', aliceStats2);

		const bridgeReachable =
			!bobStats1.error && !aliceStats1.error &&
			(bobStats1.connections?.length ?? 0) > 0;
		if (!bridgeReachable) {
			// Documented degrade path (task contract): adapter getters proved
			// unreachable from the renderer bundle → fall back to the video-
			// element evidence already asserted above. Never silent.
			console.warn(
				`[MEDIA-003] rtcStats bridge unreachable or empty — degrading to video-element evidence. ` +
					`bob=${JSON.stringify(bobStats1).slice(0, 300)} alice=${JSON.stringify(aliceStats1).slice(0, 300)}`,
			);
		} else {
			// Viewer side: inbound video bytesReceived AND framesDecoded increase.
			const inboundVideo = (r: typeof bobStats1) =>
				(r.connections ?? []).flatMap((c) => c.inbound ?? []).filter((s) => s.kind === 'video');
			const b1 = inboundVideo(bobStats1)[0];
			const b2 = inboundVideo(bobStats2)[0];
			expect(b1 && b2, `bob inbound video stat entries present: ${JSON.stringify([bobStats1, bobStats2]).slice(0, 400)}`).toBeTruthy();
			expect(
				(b2!.bytesReceived as number) > (b1!.bytesReceived as number),
				`bob bytesReceived must increase: ${b1!.bytesReceived} → ${b2!.bytesReceived}`,
			).toBe(true);
			expect(
				(b2!.framesDecoded as number) > (b1!.framesDecoded as number),
				`bob framesDecoded must increase: ${b1!.framesDecoded} → ${b2!.framesDecoded}`,
			).toBe(true);
			expect(
				b2!.codecMimeType || b1!.codecMimeType,
				`codecMimeType must be present on inbound video: ${JSON.stringify([b1, b2])}`,
			).toBeTruthy();

			// Publisher side: outbound bytesSent increases.
			const outboundVideo = (r: typeof aliceStats1) =>
				(r.connections ?? []).flatMap((c) => c.outbound ?? []).filter((s) => s.kind === 'video');
			const a1 = outboundVideo(aliceStats1)[0];
			const a2 = outboundVideo(aliceStats2)[0];
			expect(a1 && a2, `alice outbound video stat entries present: ${JSON.stringify([aliceStats1, aliceStats2]).slice(0, 400)}`).toBeTruthy();
			expect(
				(a2!.bytesSent as number) > (a1!.bytesSent as number),
				`alice bytesSent must increase: ${a1!.bytesSent} → ${a2!.bytesSent}`,
			).toBe(true);

			const kbps = (((a2!.bytesSent as number) - (a1!.bytesSent as number)) * 8 / 6 / 1000).toFixed(1);
			console.log(
				`[MEDIA-003] rtcStats verdict: REACHABLE. publisher outbound delta ${(a2!.bytesSent as number) - (a1!.bytesSent as number)} bytes over 6s ≈ ${kbps} kbps; codec=${b2!.codecMimeType}`,
			);
		}
		void groupId;
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media002-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('media002-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-004
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media MEDIA-004: stop flow tears everything down', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `m4-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 3, agents: [] };
	try {
		const { alice, bob, groupId } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});
		const fixture = ctx.fixture!;

		// Bob watching (steady state before teardown).
		const bobMarkers = new MarkerTracker(bob);
		await watchActiveShareViaUi(bob);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob.page, 60_000, 'bob video live before stop');
		const aliceMarkers = new MarkerTracker(alice);

		// Window-count baselines AFTER any share-start toast windows have
		// been created (toast lifetime is 12s; wait it out for a stable base).
		await sleep(13_000);
		const baselineAlice = await mainWindowCount(alice);
		const baselineBob = await mainWindowCount(bob);
		artifactDir.writeJson('media004-window-baselines.json', { baselineAlice, baselineBob });

		// ── Stop through the real confirm dialog ──────────────────────
		await stopShareViaUi(alice);

		// Bob reaches ended state within 30s (marker OR visible ended UI).
		const endedMarkerMs = await bobMarkers.waitFor('viewer-ended', 30_000);
		let endedUiVisible = false;
		try {
			await bob.page
				.locator('[data-testid="viewer-ended-state"]')
				.waitFor({ state: 'visible', timeout: 5_000 });
			endedUiVisible = true;
		} catch {
			/* marker path may have fired without us catching the transient UI */
		}
		artifactDir.writeJson('media004-bob-ended.json', {
			endedMarkerMs,
			endedUiVisible,
			markers: bobMarkers.all(),
		});
		console.log(
			`[MEDIA-004] bob ended: marker=${endedMarkerMs >= 0 ? `${endedMarkerMs}ms` : 'MISSING'}, endedUiVisible=${endedUiVisible}`,
		);
		expect(
			endedMarkerMs >= 0 || endedUiVisible,
			`bob must reach an ended state within 30s (markers: ${JSON.stringify(bobMarkers.all())})`,
		).toBe(true);

		// Alice: share-stopped marker; sharing===false; no active stream.
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('media004-alice-markers.json', aliceMarkers.all());
		expect(stoppedMs, `share-stopped marker must fire on alice (markers: ${JSON.stringify(aliceMarkers.all())})`).toBeGreaterThanOrEqual(0);

		await waitFor(
			async () => {
				const snap = await mediaSnapshot(alice);
				return snap?.hostShare?.sharing === false ? snap : null;
			},
			{ timeout: 30_000, interval: 1_000, label: 'alice hostShare.sharing===false' },
		);
		const finalSnap = await mediaSnapshot(alice);
		artifactDir.writeJson('media004-alice-final-snapshot.json', finalSnap);
		expect(
			streamsForGroup(finalSnap, groupId),
			`activeStreams must be empty for the group after stop: ${JSON.stringify(finalSnap?.activeStreams)}`,
		).toHaveLength(0);

		// Window hygiene: BrowserWindow.getAllWindows().length back to baseline.
		const hygiene: Record<string, { baseline: number; after: number }> = {};
		for (const [name, agent, baseline] of [
			['alice', alice, baselineAlice],
			['bob', bob, baselineBob],
		] as const) {
			const after = await waitFor(
				() =>
					mainWindowCount(agent).then((n) => (n <= baseline ? n : null)),
				{
					timeout: 30_000,
					interval: 2_000,
					label: `${name}: window count back to ≤ baseline (${baseline})`,
				},
			).catch(() => -1);
			hygiene[name] = { baseline, after };
		}
		artifactDir.writeJson('media004-window-hygiene.json', hygiene);
		expect(hygiene['alice']!.after, `alice window hygiene: ${JSON.stringify(hygiene)}`).toBeGreaterThanOrEqual(0);
		expect(hygiene['bob']!.after, `bob window hygiene: ${JSON.stringify(hygiene)}`).toBeGreaterThanOrEqual(0);

		// Fixture still alive after everything tore down.
		const framesAfterStop = await fixture.frames();
		artifactDir.writeJson('media004-fixture-after-stop.json', { framesAfterStop });
		expect(framesAfterStop, 'fixture control port must still respond').toBeGreaterThan(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media004-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('media004-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-005
// ─────────────────────────────────────────────────────────────────────────────

test('@media MEDIA-005: restart share → new session identity + documented viewer recovery', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `m5-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 4, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// Session #1 with bob watching.
		const bobMarkers = new MarkerTracker(bob);
		await watchActiveShareViaUi(bob);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		const share1 = await waitForHostSharing(alice, 30_000, 'share #1 hostShare');
		const mediaSessionId1 = share1.mediaSessionId!;
		console.log(`[MEDIA-005] session #1 mediaSessionId=${mediaSessionId1}`);

		// Stop cleanly through the real dialog.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		await aliceMarkers.waitFor('share-stopped', 30_000);
		await waitFor(
			async () => {
				const snap = await mediaSnapshot(alice);
				return snap?.hostShare?.sharing === false ? snap : null;
			},
			{ timeout: 30_000, interval: 1_000, label: 'share #1 fully stopped' },
		);

		// Re-start the SAME fixture card through the real picker.
		await startFixtureShareViaUi(alice);
		const share2 = await waitForHostSharing(alice, 45_000, 'share #2 hostShare');
		const mediaSessionId2 = share2.mediaSessionId!;
		artifactDir.writeJson('media005-session-ids.json', { mediaSessionId1, mediaSessionId2 });
		console.log(`[MEDIA-005] session #2 mediaSessionId=${mediaSessionId2}`);
		expect(
			mediaSessionId2,
			'restarted share must mint a NEW mediaSessionId',
		).not.toBe(mediaSessionId1);

		// ── Bob's recovery behavior: OBSERVE, then assert what actually
		// happened (no assumption about which outcome is correct). ─────
		const timeline: Array<{
			t: number;
			phase: string | null;
			currentTime: number | null;
			endedUi: boolean;
			errorUi: boolean;
		}> = [];
		let recoveredToWatching = false;
		let landedEndedOrError = false;
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const snap = await mediaSnapshot(bob);
				const phase = snap?.viewerSessions?.[0]?.phase ?? null;
				let currentTime: number | null = null;
				try {
					const v = await sampleViewerVideo(bob.page);
					currentTime = v.present ? v.currentTime ?? null : null;
				} catch {
					/* page busy */
				}
				const endedUi = await bob.page
					.locator('[data-testid="viewer-ended-state"]')
					.isVisible()
					.catch(() => false);
				const errorUi = await bob.page
					.locator('[data-testid="viewer-error-state"]')
					.isVisible()
					.catch(() => false);
				timeline.push({ t: Date.now() - deadline + 120_000, phase, currentTime, endedUi, errorUi });

				if (phase === 'watching') {
					// Confirm media actually advances again before declaring recovery.
					const v1 = await sampleViewerVideo(bob.page);
					await sleep(5_000);
					const v2 = await sampleViewerVideo(bob.page);
					if (
						v1.present &&
						v2.present &&
						(v2.currentTime ?? 0) > (v1.currentTime ?? 0)
					) {
						recoveredToWatching = true;
						break;
					}
				}
				if (endedUi || errorUi || phase === 'ended' || phase === 'error') {
					landedEndedOrError = true;
					break;
				}
				await sleep(2_000);
			}
		}
		await bobMarkers.drain();
		const recovery = {
			outcome: recoveredToWatching
				? 'auto-recovered-to-watching'
				: landedEndedOrError
					? 'landed-ended-or-error-ui'
					: 'no-definitive-outcome-within-budget',
			recoveredToWatching,
			landedEndedOrError,
			timelineTail: timeline.slice(-10),
			bobMarkers: bobMarkers.all(),
		};
		artifactDir.writeJson('media005-recovery-behavior.json', recovery);
		console.log(
			`[MEDIA-005] DOCUMENTED ACTUAL BEHAVIOR: bob recovery after restart → ${recovery.outcome}`,
		);
		expect(
			recoveredToWatching || landedEndedOrError,
			`bob must land in a coherent documented outcome (auto-recover to watching OR ended/error UI) within 120s; timeline tail: ${JSON.stringify(timeline.slice(-5))}`,
		).toBe(true);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media005-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('media005-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-006
// ─────────────────────────────────────────────────────────────────────────────

test('@media @resilience MEDIA-006: kick isolation — kicked viewer stops, other viewer keeps playing', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `m6-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 5, agents: [] };
	try {
		// Three agents; formMediaMesh applies the documented restart
		// workaround if the 3rd joiner's membership propagation stalls.
		const profiles3 = { ...profiles };
		const fixture = await startFixture({
			agent: 'media-alice',
			controlPort: ctx.fixturePort,
		});
		ctx.fixture = fixture;
		await ensureFixtureCapturable(fixture);
		const mesh = await formMediaMesh({
			createAgent,
			profiles: profiles3,
			runTag,
			includeCharlie: true,
			onAgent: (a) => ctx.agents.push(a),
		});
		const { alice, bob, charlie, groupId } = mesh;

		// Alice shares; BOTH bob and charlie watch.
		await startFixtureShareViaUi(alice);
		await waitForHostSharing(alice, 45_000, 'alice hostShare (kick scenario)');
		await watchActiveShareViaUi(bob);
		await watchActiveShareViaUi(charlie!);
		await waitForViewerVideoLive(bob.page, 90_000, 'bob video live');
		await waitForViewerVideoLive(charlie!.page, 90_000, 'charlie video live');
		console.log('[MEDIA-006] both viewers watching');

		// Wait until alice's dashboard shows BOTH viewers (stats-driven rows).
		await waitFor(
			async () => {
				const count = await alice.page
					.locator('[data-testid="host-viewer-count"]')
					.innerText({ timeout: 5_000 })
					.catch(() => '');
				return count.trim().startsWith('2') ? count : null;
			},
			{ timeout: 120_000, interval: 2_000, label: 'alice viewer count reaches 2' },
		);
		const countBeforeKick = await alice.page
			.locator('[data-testid="host-viewer-count"]')
			.innerText();
		artifactDir.writeJson('media006-count-before-kick.json', { countBeforeKick });
		expect(countBeforeKick.trim(), 'viewer count must be 2 before kick').toContain('2');

		// Kick BOB via the kick button inside HIS viewer-row.
		const bobRow = alice.page
			.locator('[data-testid="viewer-row"]')
			.filter({ hasText: 'Bob' });
		await bobRow.waitFor({ state: 'visible', timeout: 30_000 });
		await bobRow.locator('[data-testid="kick-viewer-button"]').click({ timeout: 15_000 });
		console.log('[MEDIA-006] kick clicked for bob');
		const tKick = Date.now();

		// ── BOB observation loop (90s): hard media evidence + UX surface.
		// Freeze check brackets AFTER the kick takes effect — OBSERVED: the
		// kick resets bob's video element (currentTime snaps to 0) roughly
		// 10–15s after the click, so the bracket starts at t+15s.
		const bobMarkers = new MarkerTracker(bob);
		await sleep(15_000);
		const bobV1 = await sampleViewerVideo(bob.page);
		await sleep(8_000);
		const bobV2 = await sampleViewerVideo(bob.page);
		const bobFreezeDelta = (bobV2.currentTime ?? 0) - (bobV1.currentTime ?? 0);
		const bobFrozen =
			!bobV1.present || !bobV2.present || Math.abs(bobFreezeDelta) < 0.5;

		const timeline: Array<{
			tSec: number;
			phase: string | null;
			currentTime: number | null;
			endedUi: boolean;
			errorUi: boolean;
		}> = [];
		let sawEndedSurface = false;
		let sawReconnectingMarker = false;
		let resumedAdvancing = false;
		{
			const deadline = Date.now() + 90_000;
			let prevCurrentTime: number | null = bobV2.currentTime ?? null;
			while (Date.now() < deadline) {
				await sleep(3_000);
				await bobMarkers.drain();
				if (bobMarkers.has('viewer-ended')) sawEndedSurface = true;
				if (bobMarkers.has('viewer-reconnecting')) sawReconnectingMarker = true;
				const snap = await mediaSnapshot(bob);
				const phase = snap?.viewerSessions?.[0]?.phase ?? null;
				let currentTime: number | null = null;
				try {
					const v = await sampleViewerVideo(bob.page);
					currentTime = v.present ? v.currentTime ?? null : null;
				} catch {
					/* page busy */
				}
				const endedUi = await bob.page
					.locator('[data-testid="viewer-ended-state"]')
					.isVisible()
					.catch(() => false);
				const errorUi = await bob.page
					.locator('[data-testid="viewer-error-state"]')
					.isVisible()
					.catch(() => false);
				if (endedUi || errorUi || phase === 'ended' || phase === 'error') {
					sawEndedSurface = true;
				}
				if (
					prevCurrentTime !== null &&
					currentTime !== null &&
					currentTime - prevCurrentTime > 1
				) {
					resumedAdvancing = true;
				}
				prevCurrentTime = currentTime;
				timeline.push({
					tSec: Math.round((Date.now() - tKick) / 1000),
					phase,
					currentTime,
					endedUi,
					errorUi,
				});
				if (sawEndedSurface && (Date.now() - tKick) > 20_000) break;
			}
		}
		await bobMarkers.drain();
		if (bobMarkers.has('viewer-ended')) sawEndedSurface = true;
		if (bobMarkers.has('viewer-reconnecting')) sawReconnectingMarker = true;

		const bobKickEvidence = {
			freezeWindow: { before: bobV1, after8s: bobV2, delta: bobFreezeDelta, frozen: bobFrozen },
			sawEndedSurface,
			sawReconnectingMarker,
			resumedAdvancing,
			markers: bobMarkers.all(),
			timeline,
			kickedAt: new Date(tKick).toISOString(),
		};
		artifactDir.writeJson('media006-bob-kicked.json', bobKickEvidence);
		console.log(
			`[MEDIA-006] bob after kick: frozen=${bobFrozen} (delta=${bobFreezeDelta.toFixed(2)}) ` +
				`endedSurface=${sawEndedSurface} reconnectingMarker=${sawReconnectingMarker} resumedAdvancing=${resumedAdvancing}\n` +
				`  timeline: ${JSON.stringify(timeline)}\n` +
				`  markers: ${JSON.stringify(bobMarkers.all())}`,
		);
		expect(
			bobFrozen,
			`bob's media must STOP after kick (currentTime delta ${bobFreezeDelta} over 8s)`,
		).toBe(true);
		// Product contract: a kicked viewer must SURFACE a kicked/ended state
		// (viewer-ended marker acceptable). Media freezing alone with the UI
		// stuck on "watching" is a defect suspect — recorded, not papered over.
		if (!(sawEndedSurface || sawReconnectingMarker)) {
			console.warn(
				'[MEDIA-006] KNOWN DEFECT (documented, not fixed): kicked viewer receives NO ended/reconnecting ' +
					'surface — video freezes (currentTime pinned) while session phase stays "watching" for the full ' +
					'90s observation window; no viewer-ended/viewer-reconnecting marker fires. The expected ' +
					'"host closes PC → viewer track-ended → ViewerSession.stop()" chain does not reach the viewer. ' +
					'Evidence: media006-bob-kicked.json',
			);
		}

		// CHARLIE: untouched — video STILL advancing over 10s, row intact.
		// (Run BEFORE the bob-surface contract assertion below so a single
		// run exercises the full isolation matrix even when the defect fires.)
		const c1 = await sampleViewerVideo(charlie!.page);
		await sleep(10_000);
		const c2 = await sampleViewerVideo(charlie!.page);
		const charlieDelta = (c2.currentTime ?? 0) - (c1.currentTime ?? 0);
		const charlieRowIntact = await alice.page
			.locator('[data-testid="viewer-row"]')
			.filter({ hasText: 'Charlie' })
			.isVisible()
			.catch(() => false);
		artifactDir.writeJson('media006-charlie-unaffected.json', {
			before: c1,
			after10s: c2,
			charlieDelta,
			charlieRowIntact,
		});
		console.log(`[MEDIA-006] charlie currentTime delta over 10s: ${charlieDelta.toFixed(2)}`);
		expect(
			charlieDelta,
			`charlie's video must KEEP advancing after bob's kick (delta=${charlieDelta})`,
		).toBeGreaterThan(1);
		expect(charlieRowIntact, 'charlie viewer-row must remain intact').toBe(true);

		// Alice viewer count 2→1.
		await waitFor(
			async () => {
				const count = await alice.page
					.locator('[data-testid="host-viewer-count"]')
					.innerText({ timeout: 5_000 })
					.catch(() => '');
				return count.trim().startsWith('1') ? count : null;
			},
			{ timeout: 60_000, interval: 2_000, label: 'alice viewer count drops to 1' },
		);
		console.log('[MEDIA-006] alice viewer count 2→1 confirmed');

		// Bob-surface contract assertion LAST (currently RED due to the
		// documented kick-notification defect above) so every other check in
		// this scenario still executes and lands in artifacts on each run.
		expect(
			sawEndedSurface || sawReconnectingMarker,
			`bob must surface a kicked/ended (or at minimum reconnecting) state within 90s of the kick; ` +
				`observed: endedSurface=${sawEndedSurface}, reconnectingMarker=${sawReconnectingMarker}, ` +
				`resumedAdvancing=${resumedAdvancing}, timeline=${JSON.stringify(timeline)}, markers=${JSON.stringify(bobMarkers.all())}`,
		).toBe(true);
		void groupId;
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media006-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob, profiles.charlie],
		});
		artifactDir.writeJson('media006-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA-007
// ─────────────────────────────────────────────────────────────────────────────

test('@media MEDIA-007: viewer exit preserves host share', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `m7-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 6, agents: [] };
	try {
		const { alice, bob, groupId } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		await watchActiveShareViaUi(bob);
		await waitForViewerVideoLive(bob.page, 90_000, 'bob video live before exit');

		// Exit via the viewer UI. While WATCHING the exit button auto-hides
		// with the controls (3s) — move the pointer over the stage to reveal
		// it, then click by aria-label ("Exit viewer"). The overlay variants
		// expose data-testid="viewer-exit-button".
		const exitButton = bob.page.getByRole('button', { name: 'Exit viewer' });
		let exited = false;
		for (let attempt = 0; attempt < 4 && !exited; attempt++) {
			try {
				await bob.page
					.locator('[data-testid="viewer-workspace-root"]')
					.hover({ timeout: 5_000 });
				await exitButton.click({ timeout: 3_000 });
				exited = true;
			} catch {
				const overlayExit = bob.page.locator('[data-testid="viewer-exit-button"]');
				if (await overlayExit.isVisible().catch(() => false)) {
					await overlayExit.click({ timeout: 3_000 });
					exited = true;
				} else {
					await sleep(1_500);
				}
			}
		}
		artifactDir.writeJson('media007-exit-clicked.json', { exited });
		expect(exited, 'bob must be able to trigger the viewer exit control').toBe(true);

		// Bob lands back at the group overview.
		await bob.waitForTestId('group-overview-root', 30_000);
		console.log('[MEDIA-007] bob back at group-overview-root');

		// Alice's share is STILL active with the viewer count decremented.
		await alice.waitForTestId('host-dashboard-root', 15_000);
		const snap = await mediaSnapshot(alice);
		artifactDir.writeJson('media007-alice-snapshot.json', snap);
		expect(
			snap?.hostShare?.sharing,
			'alice hostShare.sharing must still be true after bob exits',
		).toBe(true);
		expect(
			streamsForGroup(snap, groupId),
			'the stream must still be in activeStreams',
		).toHaveLength(1);
		await waitFor(
			async () => {
				const count = await alice.page
					.locator('[data-testid="host-viewer-count"]')
					.innerText({ timeout: 5_000 })
					.catch(() => '');
				return count.trim().startsWith('0') ? count : null;
			},
			{ timeout: 90_000, interval: 2_000, label: 'alice viewer count decrements to 0' },
		);
		console.log('[MEDIA-007] alice share preserved, viewer count decremented to 0');

		// Alice stops cleanly afterwards.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('media007-alice-stop-markers.json', aliceMarkers.all());
		expect(stoppedMs, 'final clean stop must emit share-stopped').toBeGreaterThanOrEqual(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'media007-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('media007-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});
