/**
 * media-ui.spec.ts — HOST-SIDE UI scenarios on top of the REAL media
 * pipeline (same fixture-window client / mesh formation / watch helpers
 * as media.spec.ts). Fills host-dashboard + ShareSetup UI gaps that
 * MEDIA-001..007 do not cover.
 *
 * MHST-001 host stop CANCEL keeps the share alive        (@critical @media)
 * MHST-002 restart confirm cancel vs confirm             (@media)
 * MHST-003 switch source during an active share          (@media)
 * MHST-004 share a WINDOW source end-to-end              (@critical @media)
 * MHST-005 host stream-details card populates            (@media)
 * MHST-006 viewer count + row transitions                (@media)
 * MHST-007 'Use last settings' restoration               (@media)
 * MHST-008 share-start toast fires exactly once          (@media)
 *
 * OUT OF SCOPE by contract: A/B compare (CompareViewerSurface) and all
 * NVIDIA upscaling / VSR / benchmark scenarios.
 *
 * Product paths verified (read, never edited):
 * - apps/desktop/src/renderer/components/workspace/ShareSetup.tsx —
 *   source tabs/cards, audio RadioGroup, quality inputs
 *   (custom-fps-input / custom-bitrate-input), "Use last settings"
 *   button (NO testid — role/name only), sonner toast "Sharing started".
 * - apps/desktop/src/renderer/components/workspace/HostDashboard.tsx —
 *   stop-confirm-dialog (+stop-cancel-button), restart-confirm-dialog
 *   (cancel button has NO testid — role/name only), transient
 *   "Restarting…"/disabled restart-share-button, switch-source-dialog /
 *   switch-source-item / switch-confirm-button, Stream details card
 *   (values have NO testids — located by adjacent label text),
 *   host-viewer-count / viewer-row[data-viewer-state].
 *
 * NOTE: setupHostShare below is a minimal LOCAL copy of media.spec.ts's
 * file-private helper of the same name (it is not exported there); all
 * other building blocks are imported from helpers-media/helpers-mesh.
 */
import { test, expect } from '../framework/fixtures.js';
import { startFixture, type FixtureHandle } from '../fixtures/fixture-window/client.js';
import {
	makeMediaProfiles,
	formMediaMesh,
	mediaSnapshot,
	waitForHostSharing,
	sampleViewerVideo,
	waitForViewerVideoLive,
	startFixtureShareViaUi,
	stopShareViaUi,
	watchActiveShareViaUi,
	mediaCleanupChecks,
	ensureFixtureCapturable,
	sleep,
	waitFor,
} from './helpers-media.js';
import {
	MarkerTracker,
	shutdownAgent,
	setDisplayNameViaSettings,
	createGroupViaUi,
} from './helpers-mesh.js';
import type { AgentController } from '../framework/agent.js';

/** Per-run unique tag so profiles/fixtures never collide with stale runs. */
const RUN = `${process.pid}-${Date.now() % 100000}`;

/** Fixture control ports are explicit so cleanup can verify port release. */
const FIXTURE_PORT_BASE = 9810;

type AgentList = AgentController[];

interface MediaUiTestContext {
	fixture: FixtureHandle | null;
	fixturePort: number;
	agents: AgentList;
}

interface MediaUiSetup {
	alice: AgentController;
	bob: AgentController | null;
	groupId: string;
	groupName: string;
}

/**
 * Shared per-test scaffolding: fixture + alice creates group (+ optional
 * bob joins) + alice starts sharing the fixture through the real picker.
 * Minimal local copy of media.spec.ts's private setupHostShare.
 */
async function setupHostShare(opts: {
	createAgent: (name?: string) => Promise<AgentController>;
	runTag: string;
	fixturePort: number;
	ctx: MediaUiTestContext;
	includeBob?: boolean;
	startShare?: boolean;
}): Promise<MediaUiSetup> {
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

	let alice: AgentController;
	let bob: AgentController | null = null;
	let groupId: string;
	const groupName = `Media UI ${opts.runTag}`;

	if (opts.includeBob === false) {
		// Single-host scenario: no viewer needed — skip mesh formation.
		alice = await opts.createAgent(profiles.alice);
		opts.ctx.agents.push(alice);
		await alice.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(alice, 'Alice');
		groupId = (await createGroupViaUi(alice, groupName)).groupId;
	} else {
		const mesh = await formMediaMesh({
			createAgent: opts.createAgent,
			profiles,
			runTag: opts.runTag,
			includeCharlie: false,
			onAgent: (a) => opts.ctx.agents.push(a),
		});
		alice = mesh.alice;
		bob = mesh.bob;
		groupId = mesh.groupId;
	}

	// Fixture liveness probe right before the picker opens.
	try {
		const framesNow = await fixture.frames();
		console.log(`[setupHostShare] fixture alive before share, frames=${framesNow}`);
	} catch (err) {
		throw new Error(`fixture control server unreachable before share start: ${String(err)}`);
	}

	if (opts.startShare !== false) {
		await startFixtureShareViaUi(alice);
	}
	return { alice, bob, groupId, groupName };
}

/**
 * Viewer frame-advance proof (MEDIA-002 mechanism): currentTime must
 * strictly increase across two samples bracketing a 5s sleep.
 */
async function expectViewerAdvancing(page: AgentController['page'], label: string): Promise<void> {
	const v1 = await sampleViewerVideo(page);
	await sleep(5_000);
	const v2 = await sampleViewerVideo(page);
	expect(
		v1.present && v2.present,
		`${label}: viewer-video element must stay present`,
	).toBe(true);
	expect(
		(v2.currentTime ?? 0) - (v1.currentTime ?? 0),
		`${label}: currentTime must advance (${v1.currentTime} → ${v2.currentTime})`,
	).toBeGreaterThan(1);
}

/** Exit the viewer via the real UI (MEDIA-007 pattern). Returns success. */
async function exitViewerViaUi(agent: AgentController): Promise<boolean> {
	const exitButton = agent.page.getByRole('button', { name: 'Exit viewer' });
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			// While WATCHING the exit button auto-hides with the controls (3s) —
			// move the pointer over the stage to reveal it first.
			await agent.page
				.locator('[data-testid="viewer-workspace-root"]')
				.hover({ timeout: 5_000 });
			await exitButton.click({ timeout: 3_000 });
			return true;
		} catch {
			const overlayExit = agent.page.locator('[data-testid="viewer-exit-button"]');
			if (await overlayExit.isVisible().catch(() => false)) {
				await overlayExit.click({ timeout: 3_000 });
				return true;
			}
			await sleep(1_500);
		}
	}
	return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// MHST-001
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media MHST-001: host stop CANCEL keeps the share alive', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `h1-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 1, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// Steady state: bob watching.
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live before stop-cancel');

		const shareBefore = await waitForHostSharing(alice, 30_000, 'hostShare before stop dialog');
		const sourceLabelBefore = await alice.page
			.locator('[data-testid="host-source-label"]')
			.innerText({ timeout: 15_000 });

		// Open the stop flow, then CANCEL it.
		await alice.clickTestId('stop-sharing-button', 20_000);
		await alice.waitForTestId('stop-confirm-dialog', 15_000);
		await alice.clickTestId('stop-cancel-button', 15_000);
		await alice.page
			.locator('[data-testid="stop-confirm-dialog"]')
			.waitFor({ state: 'hidden', timeout: 15_000 });

		// Host STILL sharing: dashboard intact, same session identity, same source.
		await alice.waitForTestId('host-dashboard-root', 15_000);
		const snapAfterCancel = await mediaSnapshot(alice);
		artifactDir.writeJson('mhst001-snapshot-after-cancel.json', snapAfterCancel);
		expect(
			snapAfterCancel?.hostShare?.sharing,
			'hostShare.sharing must still be true after cancel',
		).toBe(true);
		expect(
			snapAfterCancel?.hostShare?.sessionId,
			'sessionId must be unchanged after cancel',
		).toBe(shareBefore.sessionId);
		expect(
			snapAfterCancel?.hostShare?.mediaSessionId,
			'mediaSessionId must be unchanged after cancel',
		).toBe(shareBefore.mediaSessionId);
		const sourceLabelAfter = await alice.page
			.locator('[data-testid="host-source-label"]')
			.innerText({ timeout: 15_000 });
		artifactDir.writeJson('mhst001-source-labels.json', { sourceLabelBefore, sourceLabelAfter });
		expect(sourceLabelAfter.trim(), 'source label must be unchanged after cancel').toBe(
			sourceLabelBefore.trim(),
		);

		// Viewer STILL playing (frame/sample advancement).
		await expectViewerAdvancing(bob!.page, 'after stop-cancel');

		// Clean teardown via the confirm path.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('mhst001-alice-stop-markers.json', aliceMarkers.all());
		expect(stoppedMs, 'final confirm-stop must emit share-stopped').toBeGreaterThanOrEqual(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst001-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst001-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-002
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-002: restart confirmation cancel keeps identity, confirm mints a new session', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `h2-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 2, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// Session #1 with bob watching.
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live before restart flows');
		const share1 = await waitForHostSharing(alice, 30_000, 'session #1 hostShare');
		const sessionId1 = share1.sessionId!;
		const mediaSessionId1 = share1.mediaSessionId!;
		console.log(`[MHST-002] session #1 sessionId=${sessionId1} mediaSessionId=${mediaSessionId1}`);

		// ── CANCEL path ────────────────────────────────────────────────
		await alice.clickTestId('restart-share-button', 20_000);
		await alice.waitForTestId('restart-confirm-dialog', 15_000);
		// The restart dialog's Cancel button carries NO testid
		// (HostDashboard restart dialog footer) — role/name only.
		await alice.page
			.locator('[data-testid="restart-confirm-dialog"]')
			.getByRole('button', { name: 'Cancel' })
			.click({ timeout: 15_000 });
		await alice.page
			.locator('[data-testid="restart-confirm-dialog"]')
			.waitFor({ state: 'hidden', timeout: 15_000 });

		const snapAfterCancel = await mediaSnapshot(alice);
		artifactDir.writeJson('mhst002-snapshot-after-cancel.json', snapAfterCancel);
		expect(snapAfterCancel?.hostShare?.sharing, 'still sharing after restart-cancel').toBe(true);
		expect(
			snapAfterCancel?.hostShare?.sessionId,
			'sessionId UNCHANGED after restart-cancel',
		).toBe(sessionId1);
		expect(
			snapAfterCancel?.hostShare?.mediaSessionId,
			'mediaSessionId UNCHANGED after restart-cancel',
		).toBe(mediaSessionId1);
		await expectViewerAdvancing(bob!.page, 'after restart-cancel');

		// ── CONFIRM path ───────────────────────────────────────────────
		await alice.clickTestId('restart-share-button', 20_000);
		await alice.waitForTestId('restart-confirm-dialog', 15_000);
		await alice.clickTestId('restart-confirm-button', 15_000);

		// Transient restarting/disabled state (isRestarting → "Restarting…" +
		// disabled restart-share-button). Best-effort observation: a fast
		// restart can complete between polls — recorded, not hard-failed.
		let sawRestartingState = false;
		{
			const deadline = Date.now() + 8_000;
			const btn = alice.page.locator('[data-testid="restart-share-button"]');
			while (Date.now() < deadline && !sawRestartingState) {
				const txt = await btn.innerText().catch(() => '');
				const disabled = await btn.isDisabled().catch(() => false);
				if (txt.includes('Restarting') || disabled) sawRestartingState = true;
				else await sleep(250);
			}
		}
		artifactDir.writeJson('mhst002-restarting-state.json', { sawRestartingState });
		console.log(`[MHST-002] transient restarting/disabled state observed=${sawRestartingState}`);
		if (!sawRestartingState) {
			console.warn(
				'[MHST-002] transient "Restarting…"/disabled state NOT observed — restart completed faster than one 250ms poll',
			);
		}

		// NEW session identity afterwards. restartStream mints a NEW
		// mediaSessionId while PRESERVING the logical stream identity
		// (stream.restarted carries the old logicalStreamId), so only
		// mediaSessionId may change — same contract MEDIA-005 asserts.
		await waitFor(
			async () => {
				const hs = (await mediaSnapshot(alice))?.hostShare ?? null;
				return hs &&
					hs.sharing === true &&
					hs.sessionId === sessionId1 &&
					typeof hs.mediaSessionId === 'string' &&
					hs.mediaSessionId !== mediaSessionId1
					? hs
					: null;
			},
			{ timeout: 90_000, interval: 1_000, label: 'NEW mediaSessionId (same sessionId) after restart' },
		);
		const share2 = (await mediaSnapshot(alice))?.hostShare ?? null;
		artifactDir.writeJson('mhst002-session-ids.json', {
			sessionId1,
			mediaSessionId1,
			sessionId2: share2?.sessionId,
			mediaSessionId2: share2?.mediaSessionId,
		});
		console.log(`[MHST-002] session #2 sessionId=${share2?.sessionId} mediaSessionId=${share2?.mediaSessionId}`);

		// Viewer recovery (mirrors MEDIA-005's observation loop).
		const timeline: Array<{
			tSec: number;
			phase: string | null;
			currentTime: number | null;
			endedUi: boolean;
			errorUi: boolean;
		}> = [];
		let recoveredToWatching = false;
		let landedEndedOrError = false;
		{
			const tRestart = Date.now();
			const deadline = tRestart + 120_000;
			while (Date.now() < deadline) {
				const snap = await mediaSnapshot(bob!);
				const phase = snap?.viewerSessions?.[0]?.phase ?? null;
				let currentTime: number | null = null;
				try {
					const v = await sampleViewerVideo(bob!.page);
					currentTime = v.present ? v.currentTime ?? null : null;
				} catch {
					/* page busy */
				}
				const endedUi = await bob!.page
					.locator('[data-testid="viewer-ended-state"]')
					.isVisible()
					.catch(() => false);
				const errorUi = await bob!.page
					.locator('[data-testid="viewer-error-state"]')
					.isVisible()
					.catch(() => false);
				timeline.push({
					tSec: Math.round((Date.now() - tRestart) / 1000),
					phase,
					currentTime,
					endedUi,
					errorUi,
				});
				if (phase === 'watching') {
					// Confirm media actually advances again before declaring recovery.
					const v1 = await sampleViewerVideo(bob!.page);
					await sleep(5_000);
					const v2 = await sampleViewerVideo(bob!.page);
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
		const recovery = {
			outcome: recoveredToWatching
				? 'auto-recovered-to-watching'
				: landedEndedOrError
					? 'landed-ended-or-error-ui'
					: 'no-definitive-outcome-within-budget',
			recoveredToWatching,
			landedEndedOrError,
			timelineTail: timeline.slice(-10),
		};
		artifactDir.writeJson('mhst002-viewer-recovery.json', recovery);
		console.log(`[MHST-002] viewer recovery after restart → ${recovery.outcome}`);
		expect(
			recoveredToWatching || landedEndedOrError,
			`viewer must land in a coherent documented outcome within 120s of restart; timeline tail: ${JSON.stringify(timeline.slice(-5))}`,
		).toBe(true);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst002-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst002-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-003
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-003: switch source during an active share', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `h3-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 3, agents: [] };
	let fixtureB: FixtureHandle | null = null;
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// Viewer playing on the fixture-window source.
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live before source switch');

		// Second ANIMATED fixture as the switch target: a static desktop
		// source legitimately produces sparse frames, which would make the
		// post-switch advancement assertion physically meaningless. Placed
		// on the secondary monitor — a fully occluded window is excluded
		// from desktopCapturer enumeration on Windows.
		fixtureB = await startFixture({
			agent: 'media-switchb',
			controlPort: FIXTURE_PORT_BASE + 13,
			x: 2000,
			y: 100,
		});
		await ensureFixtureCapturable(fixtureB);
		const shareBefore = await waitForHostSharing(alice, 30_000, 'hostShare before switch');
		const labelBefore = (
			await alice.page.locator('[data-testid="host-source-label"]').innerText({ timeout: 15_000 })
		).trim();

		// Open the switch dialog and inventory the ACTUAL sources offered.
		await alice.clickTestId('switch-source-button', 20_000);
		await alice.waitForTestId('switch-source-dialog', 15_000);
		const items = alice.page.locator('[data-testid="switch-source-item"]');
		await items.first().waitFor({ state: 'visible', timeout: 30_000 });
		const titles = await items.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-source-title')),
		);
		artifactDir.writeJson('mhst003-available-sources.json', { labelBefore, titles });
		// Require the second ANIMATED fixture window as the switch target.
		// OBSERVED PLATFORM LIMITATION: while a publish session is active,
		// desktopCapturer enumeration inside the app can degrade to
		// screens-only (no windows) — switching to a static screen would
		// make the advancement assertion physically meaningless, so skip
		// truthfully instead of asserting against static-content physics.
		const targetTitle = titles.find(
			(t) => t && t.startsWith('E2E-FIXTURE:') && t !== labelBefore,
		);
		if (!targetTitle) {
			test.skip(
				true,
				`no second fixture window offered by the switch dialog while sharing is active ` +
					`(offered: ${JSON.stringify(titles)}) — window enumeration degrades during an ` +
					`active capture session on this platform`,
			);
			return;
		}
		if (!targetTitle) {
			// Truthful skip: the fixture client provides ONE fixture window and
			// this machine exposed no other capturable source to switch to.
			test.skip(
				true,
				`only ONE switchable source available (${JSON.stringify(titles)}) — cannot exercise a real source switch`,
			);
			return;
		}
		console.log(`[MHST-003] switching "${labelBefore}" → "${targetTitle}"`);

		await items.filter({ hasText: targetTitle }).first().click({ timeout: 10_000 });
		await alice.clickTestId('switch-confirm-button', 15_000);
		await alice.page
			.locator('[data-testid="switch-source-dialog"]')
			.waitFor({ state: 'hidden', timeout: 30_000 });

		// Host source label updates to the new source.
		const labelAfter = await waitFor(
			async () => {
				const lbl = await alice.page
					.locator('[data-testid="host-source-label"]')
					.innerText({ timeout: 5_000 })
					.catch(() => '');
				return lbl.trim() !== labelBefore ? lbl.trim() : null;
			},
			{ timeout: 45_000, interval: 1_000, label: 'host-source-label updates after switch' },
		);
		artifactDir.writeJson('mhst003-source-labels.json', { labelBefore, labelAfter });
		expect(
			labelAfter,
			`host-source-label must reference the NEW source title "${targetTitle}", got "${labelAfter}"`,
		).toContain(targetTitle);

		// Share still active, and the switch keeps the SAME session identity
		// (switchSourceImpl replaces the published track in place — it never
		// re-mints logicalStreamId or mediaSessionId).
		const snapAfterSwitch = await mediaSnapshot(alice);
		artifactDir.writeJson('mhst003-snapshot-after-switch.json', snapAfterSwitch);
		expect(
			snapAfterSwitch?.hostShare?.sharing,
			'hostShare.sharing must still be true after the switch',
		).toBe(true);
		expect(
			snapAfterSwitch?.hostShare?.sessionId,
			'source switch must keep the same logical stream sessionId',
		).toBe(shareBefore.sessionId);
		expect(
			snapAfterSwitch?.hostShare?.mediaSessionId,
			'source switch must keep the same mediaSessionId (in-place track replace)',
		).toBe(shareBefore.mediaSessionId);

		// Viewer stays on the SAME media session (stream.sourceChanged is
		// informational; no viewer re-bind is required) — but allow a
		// generous bounded window for the new source's frames to reach bob
		// before demanding advancement (MEDIA-005-style bounded polling).
		const advance = await waitFor(
			async () => {
				const v1 = await sampleViewerVideo(bob!.page);
				if (!v1.present) return null;
				await sleep(5_000);
				const v2 = await sampleViewerVideo(bob!.page);
				return v1.present &&
					v2.present &&
					(v2.currentTime ?? 0) - (v1.currentTime ?? 0) > 1
					? { from: v1.currentTime, to: v2.currentTime }
					: null;
			},
			{ timeout: 120_000, interval: 2_000, label: 'bob currentTime advances on the switched source' },
		);
		artifactDir.writeJson('mhst003-viewer-advance.json', advance);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		if (fixtureB) await fixtureB.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst003-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst003-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-004
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media MHST-004: share a WINDOW source end-to-end', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `h4-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 4, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
			startShare: false,
		});
		const fixture = ctx.fixture!;

		// Inline picker flow (replicates helpers-media.startFixtureShareViaUi
		// locally because MHST-004 must assert intermediate picker state:
		// Window tab active + the exact fixture card selected by title).
		await alice.clickTestId('start-share-button', 20_000);
		await alice.waitForTestId('share-setup-root', 30_000);
		await alice.clickTestId('source-tab-window', 15_000);
		const fixtureCard = alice.page.locator(
			'[data-testid="source-card"][data-source-title^="E2E-FIXTURE:"]',
		);
		await fixtureCard.first().waitFor({ state: 'visible', timeout: 30_000 });
		const cardTitle = await fixtureCard.first().getAttribute('data-source-title');
		artifactDir.writeJson('mhst004-fixture-card.json', { cardTitle, fixtureTitle: fixture.title });
		expect(cardTitle, 'window card title must match the fixture window title').toBe(fixture.title);
		await fixtureCard.first().click({ timeout: 10_000 });

		// Audio mode 'none' (same value the canonical media lane selects).
		const noneRadio = alice.page.locator(
			'[data-testid="audio-mode-select"] [role="radio"][value="none"]',
		);
		expect(
			await noneRadio.count(),
			'audio-mode-select must expose a "none" option on the window tab',
		).toBeGreaterThan(0);
		await noneRadio.click({ timeout: 10_000 });

		await alice.clickTestId('start-sharing-button', 20_000);
		await alice.waitForTestId('host-dashboard-root', 60_000);

		// Share active; host source label NAMES the window.
		const share = await waitForHostSharing(alice, 45_000, 'window-share hostShare');
		artifactDir.writeJson('mhst004-host-share.json', share);
		const sourceLabel = await alice.page
			.locator('[data-testid="host-source-label"]')
			.innerText({ timeout: 15_000 });
		artifactDir.writeJson('mhst004-source-label.json', { sourceLabel });
		expect(
			sourceLabel,
			`host-source-label must name the shared window "${fixture.title}", got "${sourceLabel}"`,
		).toContain(fixture.title);

		// Viewer plays the window share (advancement check).
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live on window share');
		await expectViewerAdvancing(bob!.page, 'window share playback');

		// Clean teardown.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('mhst004-alice-stop-markers.json', aliceMarkers.all());
		expect(stoppedMs, 'clean stop must emit share-stopped').toBeGreaterThanOrEqual(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst004-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst004-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-005
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-005: host stream-details card populates during an active share', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(720_000);
	const runTag = `h5-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 5, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// Viewer watching ≥10s so host-side capture metrics have traffic.
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live');
		await sleep(10_000);

		// Stream details card values have NO testids — read each value span
		// by its adjacent label span inside host-dashboard-root.
		const readDetails = () =>
			alice.page
				.evaluate(() => {
					const labels = ['Resolution', 'Frame rate', 'Bitrate', 'Connection'];
					const spans = Array.from(
						document.querySelectorAll('[data-testid="host-dashboard-root"] span'),
					);
					const out: Record<string, string | null> = {};
					for (const lab of labels) {
						const idx = spans.findIndex((el) => el.textContent?.trim() === lab);
						out[lab] =
							idx >= 0 && spans[idx + 1]
								? spans[idx + 1]!.textContent?.trim() ?? null
								: null;
					}
					return out;
				})
				.catch(() => null);

		// Poll up to 30s for plausible values to populate.
		const details = await waitFor(
			async () => {
				const d = await readDetails();
				if (!d) return null;
				const resolutionOk = /^\d+×\d+$/.test(d['Resolution'] ?? '');
				const fpsMatch = /^(\d+)\s+fps$/.exec(d['Frame rate'] ?? '');
				const fpsOk = fpsMatch !== null && Number(fpsMatch[1]) > 0;
				const bitrateOk = /^(?!—$).+(kbps|Mbps)$/.test(d['Bitrate'] ?? '');
				const connectionOk = d['Connection'] === 'Connected';
				return resolutionOk && fpsOk && bitrateOk && connectionOk ? d : null;
			},
			{ timeout: 30_000, interval: 2_000, label: 'stream-details populate with plausible values' },
		);
		artifactDir.writeJson('mhst005-stream-details.json', details);
		console.log(`[MHST-005] stream details: ${JSON.stringify(details)}`);
		expect(details['Resolution'] ?? '', 'resolution must render as WxH').toMatch(/^\d+×\d+$/);
		expect(details['Frame rate'] ?? '', 'frame rate must render as "<n> fps" with n>0').toMatch(
			/^[1-9]\d*\s+fps$/,
		);
		expect(details['Bitrate'] ?? '', 'bitrate must render a numeric kbps/Mbps value').toMatch(
			/^(?!—$).+(kbps|Mbps)$/,
		);
		expect(details['Connection'], 'connection must read Connected').toBe('Connected');
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst005-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst005-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-006
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-006: viewer count and viewer-row transitions on host dashboard', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `h6-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 6, agents: [] };
	try {
		const { alice, bob } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
		});

		// BEFORE any viewer: count 0, no rows.
		await alice.waitForTestId('host-dashboard-root', 15_000);
		const countBefore = await alice.page
			.locator('[data-testid="host-viewer-count"]')
			.innerText({ timeout: 15_000 });
		artifactDir.writeJson('mhst006-count-before.json', { countBefore });
		expect(countBefore.trim(), 'viewer count must start at 0').toMatch(/^0/);
		const rowLocator = alice.page.locator('[data-testid="viewer-row"]');
		await expect(rowLocator).toHaveCount(0);

		// Viewer joins → count 1 AND row progresses to playing.
		const bobMarkers = new MarkerTracker(bob!);
		await watchActiveShareViaUi(bob!);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob!.page, 60_000, 'bob video live');
		await alice.page
			.locator('[data-testid="host-viewer-count"]')
			.filter({ hasText: '1' })
			.waitFor({ state: 'visible', timeout: 90_000 });
		const rowState = await waitFor(
			async () => {
				const st = await rowLocator
					.first()
					.getAttribute('data-viewer-state', { timeout: 5_000 })
					.catch(() => null);
				return st === 'playing' ? st : null;
			},
			{ timeout: 90_000, interval: 2_000, label: 'viewer-row data-viewer-state reaches playing' },
		);
		artifactDir.writeJson('mhst006-row-playing.json', { rowState });
		expect(rowState, 'viewer-row state must reach "playing"').toBe('playing');

		// Viewer exits (MEDIA-007 pattern) → count back to 0, row gone.
		const exited = await exitViewerViaUi(bob!);
		artifactDir.writeJson('mhst006-exit-clicked.json', { exited });
		expect(exited, 'bob must be able to trigger the viewer exit control').toBe(true);
		await bob!.waitForTestId('group-overview-root', 30_000);
		await waitFor(
			async () => {
				const count = await alice.page
					.locator('[data-testid="host-viewer-count"]')
					.innerText({ timeout: 5_000 })
					.catch(() => '');
				return count.trim().startsWith('0') ? count : null;
			},
			{ timeout: 90_000, interval: 2_000, label: 'viewer count decrements to 0 after exit' },
		);
		await expect(rowLocator).toHaveCount(0, { timeout: 15_000 });

		// Clean teardown.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('mhst006-alice-stop-markers.json', aliceMarkers.all());
		expect(stoppedMs, 'final clean stop must emit share-stopped').toBeGreaterThanOrEqual(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst006-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice, profiles.bob],
		});
		artifactDir.writeJson('mhst006-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-007
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-007: share-start settings restore via pre-selection and Use last settings', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `h7-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 7, agents: [] };
	try {
		// Single-host scenario: no viewer needed for settings restoration.
		const { alice } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
			includeBob: false,
			startShare: false,
		});

		// Configure a SPECIFIC screen share: audio 'monitor' + fps 15 + bitrate 800
		// (deliberately different from defaults fps=24 / bitrate=1500 / audio none).
		await alice.clickTestId('start-share-button', 20_000);
		await alice.waitForTestId('share-setup-root', 30_000);
		await alice.clickTestId('source-tab-screen', 15_000);
		const screenCard = alice.page.locator('[data-testid="source-card"]').first();
		await screenCard.waitFor({ state: 'visible', timeout: 30_000 });
		const chosenSourceTitle = await screenCard.getAttribute('data-source-title');
		await screenCard.click({ timeout: 10_000 });

		const monitorRadio = alice.page.locator(
			'[data-testid="audio-mode-select"] [role="radio"][value="monitor"]',
		);
		if ((await monitorRadio.count()) === 0) {
			test.skip(true, 'screen tab exposes no "monitor" audio option — cannot exercise a distinct audio-mode restoration');
			return;
		}
		await monitorRadio.click({ timeout: 10_000 });
		const fpsInput = alice.page.locator('[data-testid="custom-fps-input"]');
		const bitrateInput = alice.page.locator('[data-testid="custom-bitrate-input"]');
		await fpsInput.fill('15');
		await bitrateInput.fill('800');
		artifactDir.writeJson('mhst007-chosen-settings.json', {
			chosenSourceTitle,
			audioMode: 'monitor',
			fps: 15,
			bitrate: 800,
		});

		await alice.clickTestId('start-sharing-button', 20_000);
		await alice.waitForTestId('host-dashboard-root', 60_000);

		// Stop cleanly, then reopen Share Setup.
		await stopShareViaUi(alice);
		await alice.clickTestId('start-share-button', 20_000);
		await alice.waitForTestId('share-setup-root', 30_000);

		// The component AUTO-restores last settings when the dialog opens
		// (async getSettings) — poll for the restored selections.
		await expect(monitorRadio).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 });
		await expect(fpsInput).toHaveValue('15', { timeout: 20_000 });
		await expect(bitrateInput).toHaveValue('800', { timeout: 20_000 });

		// 'Use last settings' has NO testid (role/name only). It must be
		// present, and clicking it must keep the same selections applied.
		const useLastButton = alice.page.getByRole('button', { name: 'Use last settings' });
		await expect(useLastButton).toBeVisible({ timeout: 20_000 });
		await useLastButton.click({ timeout: 10_000 });
		await expect(monitorRadio).toHaveAttribute('aria-checked', 'true');
		await expect(fpsInput).toHaveValue('15');
		await expect(bitrateInput).toHaveValue('800');
		artifactDir.writeJson('mhst007-restored.json', {
			audioModeRestored: true,
			fpsRestored: true,
			bitrateRestored: true,
			useLastSettingsClicked: true,
		});
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst007-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice],
		});
		artifactDir.writeJson('mhst007-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MHST-008
// ─────────────────────────────────────────────────────────────────────────────

test('@media MHST-008: share-start toast fires exactly once', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `h8-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: MediaUiTestContext = { fixture: null, fixturePort: FIXTURE_PORT_BASE + 8, agents: [] };
	try {
		// Single-host scenario: no viewer needed for the start toast.
		const { alice } = await setupHostShare({
			createAgent,
			runTag,
			fixturePort: ctx.fixturePort,
			ctx,
			includeBob: false,
			startShare: false,
		});

		// Open the picker and select the fixture window (canonical flow).
		await alice.clickTestId('start-share-button', 20_000);
		await alice.waitForTestId('share-setup-root', 30_000);
		await alice.clickTestId('source-tab-window', 15_000);
		const fixtureCard = alice.page.locator(
			'[data-testid="source-card"][data-source-title^="E2E-FIXTURE:"]',
		);
		await fixtureCard.first().waitFor({ state: 'visible', timeout: 30_000 });
		await fixtureCard.first().click({ timeout: 10_000 });
		const noneRadio = alice.page.locator(
			'[data-testid="audio-mode-select"] [role="radio"][value="none"]',
		);
		await noneRadio.click({ timeout: 10_000 });

		// Baseline: no "Sharing started" toast visible yet.
		const toastLoc = alice.page
			.locator('[data-sonner-toast]')
			.filter({ hasText: 'Sharing started' });
		await expect(toastLoc).toHaveCount(0);

		// Start, then observe the toast from the click onward (sonner default
		// lifetime is short, so sampling begins immediately at 250ms).
		await alice.clickTestId('start-sharing-button', 20_000);
		let maxConcurrent = 0;
		let firstSeenMs = -1;
		{
			const t0 = Date.now();
			while (Date.now() - t0 < 10_000) {
				const n = await toastLoc.count().catch(() => 0);
				if (n > maxConcurrent) {
					maxConcurrent = n;
					if (firstSeenMs < 0) firstSeenMs = Date.now() - t0;
				}
				await sleep(250);
			}
		}
		// Duplicate watch over the following 5s.
		{
			const t1 = Date.now();
			while (Date.now() - t1 < 5_000) {
				const n = await toastLoc.count().catch(() => 0);
				if (n > maxConcurrent) maxConcurrent = n;
				await sleep(250);
			}
		}

		const observations = { maxConcurrentToastElements: maxConcurrent, firstSeenMs };
		artifactDir.writeJson('mhst008-toast-observations.json', observations);
		console.log(`[MHST-008] toast observations: ${JSON.stringify(observations)}`);

		// The main-process `toast-shown` e2e marker is emitted ONLY by
		// StreamToastManager (the viewer-side "…is streaming" toast); the
		// ShareSetup success toast is a renderer-local Sonner toast and
		// leaves no marker. The DOM sampling above is the authoritative
		// evidence: appeared-within-10s + never two stacked duplicates.
		expect(
			firstSeenMs,
			`a "Sharing started" toast must appear within 10s of start (maxConcurrent=${maxConcurrent})`,
		).toBeGreaterThanOrEqual(0);
		// Never two stacked duplicates while the DOM was observed.
		expect(
			maxConcurrent,
			`at most ONE "Sharing started" toast element may show concurrently (observed max ${maxConcurrent})`,
		).toBeLessThanOrEqual(1);

		// Clean teardown.
		const aliceMarkers = new MarkerTracker(alice);
		await stopShareViaUi(alice);
		const stoppedMs = await aliceMarkers.waitFor('share-stopped', 30_000);
		artifactDir.writeJson('mhst008-alice-stop-markers.json', aliceMarkers.all());
		expect(stoppedMs, 'clean stop must emit share-stopped').toBeGreaterThanOrEqual(0);
	} finally {
		if (ctx.fixture) await ctx.fixture.stop().catch(() => {});
		for (const agent of [...ctx.agents].reverse()) {
			await shutdownAgent(agent, 'mhst008-done');
		}
		const cleanup = await mediaCleanupChecks({
			fixturePort: ctx.fixturePort,
			profileNames: [profiles.alice],
		});
		artifactDir.writeJson('mhst008-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});
