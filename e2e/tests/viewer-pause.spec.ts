/**
 * viewer-pause.spec.ts — VIEWER STREAM PAUSE/RESUME over the REAL media
 * pipeline (same fixture-window + real-picker + real-playback conventions
 * as viewer-ui.spec.ts / media.spec.ts, no mocks).
 *
 * VPAUSE-001 pause freezes frames AND stops network bytes; resume restores (@critical @media)
 * VPAUSE-002 rapid pause/resume stress — every press lands             (@media)
 * VPAUSE-003 Space key toggles pause/resume                            (@media)
 * VPAUSE-004 double-click pause lands exactly once, no stuck transition(@media)
 *
 * Product paths verified (read, never edited):
 * - apps/desktop/src/renderer/components/workspace/viewer/VideoControls.tsx —
 *   play-pause-button LIVE variant: aria-label toggles between
 *   "Pause stream" and "Resume stream"; `disabled={isStreamPauseTransitioning}`
 *   (the button is DISABLED while pausing/resuming — after every press you
 *   must WAIT for the aria-label flip, never assume instant ack).
 * - viewer/ViewerStatusOverlay.tsx — viewer-ended-state / viewer-exit-button;
 *   the ERROR overlay carries data-testid="viewer-error-state"
 *   (+ viewer-error-message / viewer-retry-button) — NOT "viewer-error".
 * - hooks/use-keyboard-shortcuts.ts — Space (key === " ", no modifiers, no
 *   repeat) on the viewer page calls getActiveController()?.togglePause();
 *   shortcuts are IGNORED while typing in input/textarea/select/contenteditable.
 * - services/test-hooks.ts — window.__screenlinkTest.rtcStats() read-only
 *   bridge exposes per-PC stats; the viewer PC is labeled "viewer" with
 *   inbound[].bytesReceived per kind.
 * - Controls auto-hide (opacity animation on video-controls-root): buttons
 *   stay mounted at opacity 0 and stay clickable, but revealControls()
 *   hover is required before pointer interactions per MEDIA-007 convention.
 */
import { test, expect } from '../framework/fixtures.js';
import type { Page } from '@playwright/test';
import { startFixture, type FixtureHandle } from '../fixtures/fixture-window/client.js';
import {
	makeMediaProfiles,
	formMediaMesh,
	sampleViewerVideo,
	waitForViewerVideoLive,
	startFixtureShareViaUi,
	watchActiveShareViaUi,
	mediaCleanupChecks,
	ensureFixtureCapturable,
	sampleRtcStats,
	sleep,
	type VideoSample,
	type RtcStatsResult,
} from './helpers-media.js';
import { MarkerTracker, shutdownAgent } from './helpers-mesh.js';
import type { AgentController } from '../framework/agent.js';

/** Per-run unique tag so profiles/fixtures never collide with stale runs. */
const RUN = `${process.pid}-${Date.now() % 100000}`;

/** Distinct port range from viewer-ui.spec (9810+) and media.spec (9730+). */
const FIXTURE_PORT_BASE = 9850;

interface ViewerTestContext {
	fixtures: FixtureHandle[];
	agents: AgentController[];
}

// ---------------------------------------------------------------------------
// Local scaffolding (replicated minimally from viewer-ui.spec.ts, which is
// intentionally lane-local and not exported; identical semantics otherwise)
// ---------------------------------------------------------------------------

/** Fixture + alice creates group + shares it; returns the formed mesh. */
async function setupHostShare(opts: {
	createAgent: (name?: string) => Promise<AgentController>;
	runTag: string;
	fixturePort: number;
	ctx: ViewerTestContext;
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
	opts.ctx.fixtures.push(fixture);
	expect(fixture.title, 'fixture title must be exactly E2E-FIXTURE:MEDIA-ALICE').toBe(
		'E2E-FIXTURE:MEDIA-ALICE',
	);
	await ensureFixtureCapturable(fixture);

	const mesh = await formMediaMesh({
		createAgent: opts.createAgent,
		profiles,
		runTag: opts.runTag,
		includeCharlie: false,
		onAgent: (a) => opts.ctx.agents.push(a),
	});

	await startFixtureShareViaUi(mesh.alice);
	return {
		alice: mesh.alice,
		bob: mesh.bob,
		groupId: mesh.groupId,
		groupName: mesh.groupName,
	};
}

/** Watch the active share through the real overview card, confirm live video. */
async function watchUntilLive(
	viewer: AgentController,
	label: string,
): Promise<VideoSample> {
	const markers = new MarkerTracker(viewer);
	await watchActiveShareViaUi(viewer);
	await markers.waitFor('viewer-watching', 90_000);
	return waitForViewerVideoLive(viewer.page, 60_000, label);
}

/**
 * Hover the viewer stage so the auto-hiding control bar becomes interactive
 * (buttons stay mounted at opacity 0; MEDIA-007 established this pattern).
 */
async function revealControls(page: Page): Promise<void> {
	// Raw pointer move instead of locator.hover: during stream switches the
	// stage can transiently fail hit-testing (pointer-events pass through to
	// <html>), which would stall actionability checks forever.
	const box = await page
		.locator('[data-testid="viewer-workspace-root"]')
		.boundingBox()
		.catch(() => null);
	if (box) {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await sleep(400);
		return;
	}
	await page.locator('[data-testid="viewer-workspace-root"]').hover({ timeout: 15_000 });
	await sleep(400);
}

/** Sample twice over `windowMs`; returns both samples and the currentTime delta. */
async function advancementWindow(
	page: Page,
	windowMs: number,
): Promise<{ a: VideoSample; b: VideoSample; delta: number }> {
	const a = await sampleViewerVideo(page);
	await sleep(windowMs);
	const b = await sampleViewerVideo(page);
	return { a, b, delta: (b.currentTime ?? 0) - (a.currentTime ?? 0) };
}

/**
 * Sum of inbound VIDEO bytes across all viewer-label PCs (null when no
 * viewer-labeled connection exists or the bridge itself errored).
 */
async function viewerInboundVideoBytes(
	agent: AgentController,
): Promise<number | null> {
	const stats: RtcStatsResult = await sampleRtcStats(agent);
	if (stats.error || !stats.connections) return null;
	const viewerConns = stats.connections.filter((c) => c.label === 'viewer');
	if (viewerConns.length === 0) return null;
	return viewerConns
		.flatMap((c) => c.inbound ?? [])
		.filter((s) => s.kind === 'video')
		.reduce((acc, s) => acc + ((s.bytesReceived as number | undefined) ?? 0), 0);
}

/** Two rtcStats samples `windowMs` apart; delta of viewer inbound video bytes. */
async function byteWindow(
	agent: AgentController,
	windowMs: number,
): Promise<{ a: number | null; b: number | null; delta: number }> {
	const a = await viewerInboundVideoBytes(agent);
	await sleep(windowMs);
	const b = await viewerInboundVideoBytes(agent);
	if (a === null || b === null) {
		throw new Error(
			`byteWindow: no viewer PC inbound video bytes (a=${a}, b=${b}; rtcStats bridge: ${JSON.stringify(await sampleRtcStats(agent))})`,
		);
	}
	return { a, b, delta: b - a };
}

/** Shared finally-block body: stop fixtures, bounded-shutdown agents, hygiene. */
async function runCleanup(
	ctx: ViewerTestContext,
	fixturePorts: number[],
	profileNames: string[],
	label: string,
): Promise<{ leftovers: unknown[]; portReleased: boolean }> {
	for (const f of ctx.fixtures) await f.stop().catch(() => {});
	for (const agent of [...ctx.agents].reverse()) {
		await shutdownAgent(agent, label);
	}
	let portReleased = true;
	for (const port of fixturePorts) {
		const check = await mediaCleanupChecks({ fixturePort: port, profileNames });
		if (!check.portReleased) portReleased = false;
		if (check.leftovers.length > 0) return { leftovers: check.leftovers as unknown[], portReleased };
	}
	return { leftovers: [], portReleased };
}

// ─────────────────────────────────────────────────────────────────────────────
// VPAUSE-001
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media VPAUSE-001: pause freezes frames AND stops network bytes; resume restores both', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vpause1-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 1;
	try {
		const { alice, bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		const live = await watchUntilLive(bob, 'bob video live (VPAUSE-001)');
		console.log(`[VPAUSE-001] video live: ${live.videoWidth}×${live.videoHeight}`);

		// Baseline network flow: viewer inbound VIDEO bytes must be flowing.
		// The fixture window can be background-throttled by Chromium (rAF
		// stalls ⇒ near-zero encoder output), so measure up to 3 windows,
		// restoring the fixture between attempts, before accepting a low
		// delta as real. A throttled source would make the paused-window
		// comparison meaningless.
		const fixture = ctx.fixtures[0] ?? null;
		let baseline = await byteWindow(bob, 4_000);
		for (
			let attempt = 1;
			baseline.delta <= 15_000 && attempt <= 3;
			attempt++
		) {
			console.warn(
				`[VPAUSE-001] baseline byte flow low (delta=${baseline.delta}, attempt ${attempt}) — ` +
					`restoring fixture and re-measuring`,
			);
			await fixture?.restore().catch(() => {});
			await sleep(1_000);
			baseline = await byteWindow(bob, 4_000);
		}
		artifactDir.writeJson('vwui-pause-001-baseline.json', baseline);
		console.log(
			`[VPAUSE-001] baseline bytes: ${baseline.a} → ${baseline.b} (delta=${baseline.delta})`,
		);
		expect(
			baseline.delta,
			`baseline inbound video bytes must flow (delta=${baseline.delta})`,
		).toBeGreaterThan(15_000);

		// ── Pause ──────────────────────────────────────────────────────
		await revealControls(bob.page);
		const ppButton = bob.page.locator('[data-testid="play-pause-button"]');
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 15_000 });
		await ppButton.click();
		// Button is disabled while transitioning — never assume instant ack.
		await expect(ppButton).toHaveAttribute('aria-label', 'Resume stream', { timeout: 20_000 });

		// Frame evidence STOPS advancing over a 4.5s window (allow 1.5s for
		// the pausing transition to land before bracketing the freeze).
		await sleep(1_500);
		const frozen = await advancementWindow(bob.page, 4_500);
		artifactDir.writeJson('vwui-pause-001-frozen.json', frozen);
		console.log(
			`[VPAUSE-001] frozen: currentTime ${frozen.a.currentTime} → ${frozen.b.currentTime} (delta=${frozen.delta.toFixed(2)}, rvfc ${frozen.a.rvfc} → ${frozen.b.rvfc})`,
		);
		expect(
			Math.abs(frozen.delta),
			`video must STOP advancing while paused (delta=${frozen.delta}, present=${frozen.a.present}/${frozen.b.present})`,
		).toBeLessThan(0.5);
		if (frozen.a.rvfc !== null && frozen.b.rvfc !== null) {
			expect(
				frozen.b.rvfc - frozen.a.rvfc,
				'rvfc frame counter must be stable while paused',
			).toBe(0);
		}

		// Network evidence: encoding disabled ⇒ inbound media bytes stop.
		// Allow tiny RTCP/signaling residue via the max() floor.
		const pausedBytes = await byteWindow(bob, 4_500);
		artifactDir.writeJson('vwui-pause-001-paused-bytes.json', pausedBytes);
		console.log(
			`[VPAUSE-001] paused bytes: ${pausedBytes.a} → ${pausedBytes.b} (delta=${pausedBytes.delta})`,
		);
		expect(
			pausedBytes.delta,
			`inbound video bytes must STOP while paused (delta=${pausedBytes.delta}, baseline delta=${baseline.delta})`,
		).toBeLessThanOrEqual(Math.max(8_000, baseline.delta * 0.25));

		// ── Resume ─────────────────────────────────────────────────────
		await revealControls(bob.page);
		await ppButton.click();
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 20_000 });

		await sleep(1_500);
		const resumed = await advancementWindow(bob.page, 5_000);
		artifactDir.writeJson('vwui-pause-001-resumed.json', resumed);
		console.log(
			`[VPAUSE-001] resumed: currentTime ${resumed.a.currentTime} → ${resumed.b.currentTime} (delta=${resumed.delta.toFixed(2)})`,
		);
		expect(
			resumed.delta,
			`video must RESUME advancing (delta=${resumed.delta})`,
		).toBeGreaterThan(1);

		const resumedBytes = await byteWindow(bob, 4_500);
		artifactDir.writeJson('vwui-pause-001-resumed-bytes.json', resumedBytes);
		console.log(
			`[VPAUSE-001] resumed bytes: ${resumedBytes.a} → ${resumedBytes.b} (delta=${resumedBytes.delta})`,
		);
		expect(
			resumedBytes.delta,
			`inbound video bytes must FLOW again after resume (delta=${resumedBytes.delta})`,
		).toBeGreaterThan(25_000);
		void alice;
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vpause001-done');
		artifactDir.writeJson('vwui-pause-001-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VPAUSE-002
// Regression signal: previously failed pause/resume acks burned 5s+ and
// DROPPED presses. A press whose aria-label transition exceeds 12s is a dead
// press = failure.
// ─────────────────────────────────────────────────────────────────────────────

test('@media VPAUSE-002: rapid pause/resume stress — every press lands', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vpause2-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 2;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VPAUSE-002)');

		const ppButton = bob.page.locator('[data-testid="play-pause-button"]');
		// 6 alternating presses (pause→resume ×3) PLUS a final pause press so
		// the scenario ENDS ON PAUSED for the freeze proof below.
		const presses: Array<{ action: 'pause' | 'resume'; expectedLabel: string }> = [
			{ action: 'pause', expectedLabel: 'Resume stream' },
			{ action: 'resume', expectedLabel: 'Pause stream' },
			{ action: 'pause', expectedLabel: 'Resume stream' },
			{ action: 'resume', expectedLabel: 'Pause stream' },
			{ action: 'pause', expectedLabel: 'Resume stream' },
			{ action: 'resume', expectedLabel: 'Pause stream' },
			{ action: 'pause', expectedLabel: 'Resume stream' },
		];
		const cycleDurations: Array<{ cycle: number; action: string; ms: number }> = [];
		for (let i = 0; i < presses.length; i++) {
			const press = presses[i]!;
			await revealControls(bob.page);
			const startedAt = Date.now();
			await ppButton.click();
			await expect(ppButton).toHaveAttribute('aria-label', press.expectedLabel, {
				timeout: 12_000,
			});
			const ms = Date.now() - startedAt;
			cycleDurations.push({ cycle: i + 1, action: press.action, ms });
			console.log(`[VPAUSE-002] press ${i + 1} (${press.action}) landed in ${ms}ms`);
		}
		artifactDir.writeJson('vpause-002-cycles.json', { cycles: cycleDurations });

		// Final freeze proof (stream is PAUSED after the last press).
		await sleep(1_500);
		const frozen = await advancementWindow(bob.page, 4_000);
		console.log(
			`[VPAUSE-002] final freeze: currentTime ${frozen.a.currentTime} → ${frozen.b.currentTime} (delta=${frozen.delta.toFixed(2)})`,
		);
		expect(
			Math.abs(frozen.delta),
			`video must be frozen at the end (delta=${frozen.delta})`,
		).toBeLessThan(0.5);

		// No error/ended overlays may appear during the stress.
		await expect(
			bob.page.locator('[data-testid="viewer-ended-state"]'),
			'ended overlay must NOT appear during stress',
		).toHaveCount(0);
		await expect(
			bob.page.locator('[data-testid="viewer-error-state"]'),
			'error overlay must NOT appear during stress',
		).toHaveCount(0);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vpause002-done');
		artifactDir.writeJson('vpause-002-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VPAUSE-003
// Product fact: Space (key === " ") on the viewer page calls
// getActiveController()?.togglePause(); shortcuts are ignored while typing
// in inputs, so focus is moved to <body> first.
// ─────────────────────────────────────────────────────────────────────────────

test('@media VPAUSE-003: Space key toggles pause/resume', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vpause3-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 3;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VPAUSE-003)');
		const ppButton = bob.page.locator('[data-testid="play-pause-button"]');

		// Ensure focus is NOT in an input before sending Space.
		await bob.page.locator('body').click({ position: { x: 10, y: 10 } });

		// Space → pause.
		await bob.page.keyboard.press('Space');
		await expect(ppButton).toHaveAttribute('aria-label', 'Resume stream', { timeout: 12_000 });
		await sleep(1_200);
		const frozen = await advancementWindow(bob.page, 3_000);
		artifactDir.writeJson('vpause-003-frozen.json', frozen);
		console.log(
			`[VPAUSE-003] frozen after Space: currentTime ${frozen.a.currentTime} → ${frozen.b.currentTime} (delta=${frozen.delta.toFixed(2)})`,
		);
		expect(
			Math.abs(frozen.delta),
			`video must freeze after Space pause (delta=${frozen.delta})`,
		).toBeLessThan(0.5);

		// Space again → resume.
		await bob.page.keyboard.press('Space');
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 12_000 });
		await sleep(1_200);
		const resumed = await advancementWindow(bob.page, 3_500);
		artifactDir.writeJson('vpause-003-resumed.json', resumed);
		console.log(
			`[VPAUSE-003] resumed after Space: currentTime ${resumed.a.currentTime} → ${resumed.b.currentTime} (delta=${resumed.delta.toFixed(2)})`,
		);
		expect(
			resumed.delta,
			`video must advance again after Space resume (delta=${resumed.delta})`,
		).toBeGreaterThan(0.8);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vpause003-done');
		artifactDir.writeJson('vpause-003-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VPAUSE-004
// Symptom under regression: a double-click left the button stuck-disabled
// forever (transitioning never resolved). The double press must land EXACTLY
// once and the button must become enabled again.
// ─────────────────────────────────────────────────────────────────────────────

test('@media VPAUSE-004: double-click pause lands exactly once, no stuck transitioning', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vpause4-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 4;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VPAUSE-004)');

		await revealControls(bob.page);
		const ppButton = bob.page.locator('[data-testid="play-pause-button"]');
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 15_000 });

		// Double-click: the SECOND press must be swallowed by the disabled
		// transitioning state, not queue a second toggle.
		await ppButton.dblclick();

		// Exactly one pause landed…
		await expect(ppButton).toHaveAttribute('aria-label', 'Resume stream', { timeout: 15_000 });
		// …and the button RECOVERS from its disabled transitioning state.
		await expect(ppButton).toBeEnabled({ timeout: 15_000 });

		await sleep(1_500);
		const frozen = await advancementWindow(bob.page, 4_000);
		artifactDir.writeJson('vpause-004.json', frozen);
		console.log(
			`[VPAUSE-004] frozen after dblclick: currentTime ${frozen.a.currentTime} → ${frozen.b.currentTime} (delta=${frozen.delta.toFixed(2)})`,
		);
		expect(
			Math.abs(frozen.delta),
			`video must be frozen after the double-click pause (delta=${frozen.delta})`,
		).toBeLessThan(0.5);

		// Single resume click recovers playback.
		await revealControls(bob.page);
		await ppButton.click();
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 20_000 });
		await sleep(1_500);
		const resumed = await advancementWindow(bob.page, 3_500);
		console.log(
			`[VPAUSE-004] resumed after single click: currentTime ${resumed.a.currentTime} → ${resumed.b.currentTime} (delta=${resumed.delta.toFixed(2)})`,
		);
		expect(
			resumed.delta,
			`single resume click must recover playback (delta=${resumed.delta})`,
		).toBeGreaterThan(0.8);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vpause004-done');
		artifactDir.writeJson('vpause-004-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});
