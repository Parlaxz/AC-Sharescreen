/**
 * viewer-ui.spec.ts — VIEWER-SIDE UI CONTROLS over the REAL media pipeline
 * (fills the viewer-UI gaps left by MEDIA-001..007; same fixture-window +
 * real-picker + real-playback conventions, no mocks).
 *
 * VWUI-001 viewer pause halts playback; resume continues   (@critical @media)
 * VWUI-002 quality request registers; stream keeps playing (@media)
 * VWUI-003 mute/unmute toggle; playback unaffected         (@media)
 * VWUI-004 stream-info overlay toggle                      (@media)
 * VWUI-005 diagnostics panel opens during live share       (@media)
 * VWUI-006 two hosts, one viewer switches streams          (@critical @media)
 * VWUI-007 ended overlay + return to overview              (@media)
 *
 * Product paths verified (read, never edited):
 * - apps/desktop/src/renderer/components/workspace/viewer/VideoControls.tsx —
 *   play-pause-button (live variant: aria-label "Pause stream"/"Resume
 *   stream"), mute-button ("Mute"/"Unmute"), stream-info-toggle,
 *   open-diagnostics-button, open-settings-button, "Switch stream" trigger.
 * - viewer/DiagnosticsPanel.tsx — diagnostics-panel-root (contentOnly inside
 *   ViewerPanelShell popover), header "ScreenLink Viewer Diagnostics",
 *   diagnostics-copy-summary-button, at-a-glance labels.
 * - viewer/StreamSwitcher.tsx — stream-switcher-root / stream-switch-option
 *   (current option carries a "Watching" badge and is disabled).
 * - viewer/ViewerStatusOverlay.tsx — viewer-ended-state / viewer-exit-button.
 * - viewer/ViewerSettingsPanel.tsx — viewer-settings-panel,
 *   quality-request-bitrate-input, Apply / Clear(/Defaults) buttons.
 *
 * DOCUMENTED PRODUCT FACTS that shape this spec (truthful, not invented):
 * - viewer/QualityPopover.tsx (quality-popover-content, Low/Medium/High/
 *   Custom presets) is DEFINED BUT NEVER MOUNTED anywhere in the renderer —
 *   the only reachable quality-request surface is the settings panel's
 *   General tab. VWUI-002 exercises THAT path.
 * - viewer/StreamInfoCard.tsx renders NO data-testid — VWUI-004 locates the
 *   overlay structurally (top-right font-mono box inside the workspace root).
 */
import { test, expect } from '../framework/fixtures.js';
import type { Page } from '@playwright/test';
import { startFixture, type FixtureHandle } from '../fixtures/fixture-window/client.js';
import {
	makeMediaProfiles,
	formMediaMesh,
	waitForHostSharing,
	sampleViewerVideo,
	waitForViewerVideoLive,
	startFixtureShareViaUi,
	stopShareViaUi,
	watchActiveShareViaUi,
	mediaCleanupChecks,
	ensureFixtureCapturable,
	sleep,
	type VideoSample,
} from './helpers-media.js';
import { MarkerTracker, shutdownAgent } from './helpers-mesh.js';
import type { AgentController } from '../framework/agent.js';

/** Per-run unique tag so profiles/fixtures never collide with stale runs. */
const RUN = `${process.pid}-${Date.now() % 100000}`;

/** Distinct port range from media.spec (9730+) so runs never collide. */
const FIXTURE_PORT_BASE = 9810;

interface ViewerTestContext {
	fixtures: FixtureHandle[];
	agents: AgentController[];
}

// ---------------------------------------------------------------------------
// Local scaffolding (replicated minimally from media.spec's setupHostShare,
// which is not exported; identical semantics otherwise)
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
 * Replicates helpers-media.startFixtureShareViaUi but selects the fixture
 * card by EXACT data-source-title. Required ONLY for VWUI-006, where TWO
 * fixture windows are alive simultaneously on one machine and the shared
 * helper's `.first()` could pick the wrong window.
 */
async function startNamedFixtureShareViaUi(
	agent: AgentController,
	title: string,
): Promise<void> {
	await agent.clickTestId('start-share-button', 20_000);
	await agent.waitForTestId('share-setup-root', 30_000);
	await agent.clickTestId('source-tab-window', 15_000);
	const card = agent.page
		.locator(`[data-testid="source-card"][data-source-title="${title}"]`);
	await card.first().waitFor({ state: 'visible', timeout: 30_000 });
	await card.first().click({ timeout: 10_000 });
	const noneRadio = agent.page.locator(
		'[data-testid="audio-mode-select"] [role="radio"][value="none"]',
	);
	if ((await noneRadio.count()) === 0) {
		throw new Error(`${agent.name}: audio-mode-select has no 'none' option`);
	}
	await noneRadio.click({ timeout: 10_000 });
	await agent.clickTestId('start-sharing-button', 20_000);
	await agent.waitForTestId('host-dashboard-root', 60_000);
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
// VWUI-001
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media VWUI-001: viewer pause halts playback; resume continues', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui1-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 1;
	try {
		const { alice, bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		const live = await watchUntilLive(bob, 'bob video live (VWUI-001)');
		console.log(`[VWUI-001] video live: ${live.videoWidth}×${live.videoHeight}`);

		// Baseline: playback advances before any UI interaction.
		const base = await advancementWindow(bob.page, 4_000);
		artifactDir.writeJson('vwui001-baseline.json', base);
		expect(
			base.delta,
			`baseline currentTime must advance (${base.a.currentTime} → ${base.b.currentTime})`,
		).toBeGreaterThan(1);

		// ── Pause ──────────────────────────────────────────────────────
		await revealControls(bob.page);
		const ppButton = bob.page.locator('[data-testid="play-pause-button"]');
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 15_000 });
		await ppButton.click();
		await expect(ppButton).toHaveAttribute('aria-label', 'Resume stream', { timeout: 20_000 });

		// Frame evidence STOPS advancing over a 4.5s window (allow 1.5s for
		// the pausing transition to land before bracketing the freeze).
		await sleep(1_500);
		const frozen = await advancementWindow(bob.page, 4_500);
		const pausedFrozen =
			!frozen.a.present || !frozen.b.present || Math.abs(frozen.delta) < 0.5;
		artifactDir.writeJson('vwui001-paused.json', frozen);
		console.log(
			`[VWUI-001] paused: currentTime ${frozen.a.currentTime} → ${frozen.b.currentTime} (delta=${frozen.delta.toFixed(2)})`,
		);
		expect(
			pausedFrozen,
			`video must STOP advancing while paused (delta=${frozen.delta}, present=${frozen.a.present}/${frozen.b.present})`,
		).toBe(true);

		// ── Resume ─────────────────────────────────────────────────────
		await revealControls(bob.page);
		await ppButton.click();
		await expect(ppButton).toHaveAttribute('aria-label', 'Pause stream', { timeout: 20_000 });

		await sleep(1_500);
		const resumed = await advancementWindow(bob.page, 5_000);
		artifactDir.writeJson('vwui001-resumed.json', resumed);
		console.log(
			`[VWUI-001] resumed: currentTime ${resumed.a.currentTime} → ${resumed.b.currentTime} (delta=${resumed.delta.toFixed(2)})`,
		);
		expect(
			resumed.a.present && resumed.b.present,
			'video element must be present after resume',
		).toBe(true);
		expect(
			resumed.delta,
			`video must RESUME advancing (delta=${resumed.delta})`,
		).toBeGreaterThan(1);
		void alice;
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui001-done');
		artifactDir.writeJson('vwui001-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-002
// NOTE on reachability: viewer/QualityPopover.tsx (quality-popover-content,
// Low/Medium/High/Custom) is defined but NEVER mounted in the product. The
// reachable quality-request surface is the settings panel (open-settings-
// button → viewer-settings-panel, General tab): bitrate input +
// Apply/Clear. This test exercises that real path.
// ─────────────────────────────────────────────────────────────────────────────

test('@media VWUI-002: quality request registers via viewer settings; stream keeps playing', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui2-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 2;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VWUI-002)');

		// Open the settings panel (the real quality-request surface).
		await revealControls(bob.page);
		await bob.clickTestId('open-settings-button', 15_000);
		const panel = bob.page.locator('[data-testid="viewer-settings-panel"]');
		await panel.waitFor({ state: 'visible', timeout: 15_000 });

		// Fresh session → no request yet → the secondary button reads "Defaults".
		const defaultsBtn = panel.getByRole('button', { name: 'Defaults', exact: true });
		await expect(defaultsBtn, 'fresh session must show Defaults (no request yet)').toBeVisible({ timeout: 15_000 });

		// Set a distinct requested bitrate and send the request.
		const bitrateInput = panel.locator('[data-testid="quality-request-bitrate-input"]');
		await bitrateInput.fill('800');
		await bitrateInput.press('Tab');
		await panel.getByRole('button', { name: 'Apply', exact: true }).click();

		// Registration proof: requestState became non-null → label flips to Clear.
		const clearBtn = panel.getByRole('button', { name: 'Clear', exact: true });
		await expect(clearBtn, 'after Apply the button must flip to Clear (request registered)').toBeVisible({ timeout: 20_000 });
		artifactDir.writeJson('vwui002-quality-request.json', { requestedBitrateKbps: 800 });

		// Close the panel; the stream MUST keep playing. The open popover
		// intercepts pointer events over the stage, so revealControls()
		// cannot run here — toggle via the button directly (opacity-0
		// controls stay clickable) with Escape as fallback.
		const settingsBtn = bob.page.locator('[data-testid="open-settings-button"]');
		try {
			await settingsBtn.click({ timeout: 5_000 });
		} catch {
			await bob.page.keyboard.press('Escape');
		}
		await panel.waitFor({ state: 'hidden', timeout: 15_000 });
		const after = await advancementWindow(bob.page, 6_000);
		artifactDir.writeJson('vwui002-after-request.json', after);
		console.log(
			`[VWUI-002] after request: currentTime ${after.a.currentTime} → ${after.b.currentTime} (delta=${after.delta.toFixed(2)})`,
		);
		expect(
			after.delta,
			`stream must KEEP PLAYING after the quality request (delta=${after.delta})`,
		).toBeGreaterThan(1);

		// Restore original (no request) — best effort, not asserted.
		try {
			await revealControls(bob.page);
			await bob.clickTestId('open-settings-button', 15_000);
			await panel.waitFor({ state: 'visible', timeout: 15_000 });
			await clearBtn.click({ timeout: 10_000 });
			// Panel is open here too — same interception rule as above.
			await settingsBtn.click({ timeout: 5_000 });
		} catch (err) {
			console.warn(`[VWUI-002] best-effort restore failed (non-fatal): ${String(err)}`);
		}
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui002-done');
		artifactDir.writeJson('vwui002-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-003
// ─────────────────────────────────────────────────────────────────────────────

test('@media VWUI-003: mute/unmute toggle flips state; playback unaffected', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui3-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 3;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VWUI-003)');

		await revealControls(bob.page);
		const muteButton = bob.page.locator('[data-testid="mute-button"]');
		await expect(muteButton).toHaveAttribute('aria-label', 'Mute', { timeout: 15_000 });

		// Mute → label flips to Unmute; media keeps advancing while muted.
		await muteButton.click();
		await expect(muteButton).toHaveAttribute('aria-label', 'Unmute', { timeout: 15_000 });
		const mutedWin = await advancementWindow(bob.page, 4_000);
		artifactDir.writeJson('vwui003-muted.json', mutedWin);
		console.log(
			`[VWUI-003] muted: currentTime ${mutedWin.a.currentTime} → ${mutedWin.b.currentTime} (delta=${mutedWin.delta.toFixed(2)})`,
		);
		expect(
			mutedWin.delta,
			`playback must continue while muted (delta=${mutedWin.delta})`,
		).toBeGreaterThan(1);

		// Unmute → label flips back to Mute; playback still advancing.
		await revealControls(bob.page);
		await muteButton.click();
		await expect(muteButton).toHaveAttribute('aria-label', 'Mute', { timeout: 15_000 });
		const unmutedWin = await advancementWindow(bob.page, 4_000);
		artifactDir.writeJson('vwui003-unmuted.json', unmutedWin);
		expect(
			unmutedWin.delta,
			`playback must continue after unmute (delta=${unmutedWin.delta})`,
		).toBeGreaterThan(1);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui003-done');
		artifactDir.writeJson('vwui003-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-004
// NOTE: StreamInfoCard renders NO data-testid (product gap, documented in the
// file header) — the overlay is located structurally: the top-right mono
// box inside the viewer workspace root.
// ─────────────────────────────────────────────────────────────────────────────

test('@media VWUI-004: stream-info overlay toggles on/off', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui4-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 4;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VWUI-004)');

		const infoCard = bob.page
			.locator('[data-testid="viewer-workspace-root"] div.absolute.top-3.right-3.font-mono');
		await expect(
			infoCard,
			'stream-info overlay must be hidden initially',
		).toHaveCount(0);

		// Toggle ON → overlay visible with non-empty metadata content.
		await revealControls(bob.page);
		await bob.clickTestId('stream-info-toggle', 15_000);
		await expect(infoCard).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(async () => (await infoCard.innerText()).trim().length, {
				timeout: 15_000,
				message: 'stream-info overlay must render non-empty metadata',
			})
			.toBeGreaterThan(0);
		const overlayText = await infoCard.innerText();
		artifactDir.writeJson('vwui004-overlay-text.json', { overlayText });
		console.log(`[VWUI-004] overlay content: ${JSON.stringify(overlayText)}`);

		// Toggle OFF → overlay hidden.
		await revealControls(bob.page);
		await bob.clickTestId('stream-info-toggle', 15_000);
		await expect(infoCard).toHaveCount(0, { timeout: 15_000 });
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui004-done');
		artifactDir.writeJson('vwui004-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-005
// ─────────────────────────────────────────────────────────────────────────────

test('@media VWUI-005: diagnostics panel opens during live share; viewer keeps playing', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui5-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 5;
	try {
		const { bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VWUI-005)');
		const before = await sampleViewerVideo(bob.page);

		// Open diagnostics via the connection dot.
		await revealControls(bob.page);
		await bob.clickTestId('open-diagnostics-button', 15_000);
		const panel = bob.page.locator('[data-testid="diagnostics-panel-root"]');
		await expect(panel, 'diagnostics panel must open').toBeVisible({ timeout: 15_000 });

		// Live content: header + copy control + at-a-glance stat sections.
		await expect(
			panel.getByText('ScreenLink Viewer Diagnostics'),
			'diagnostics header must be rendered',
		).toBeVisible({ timeout: 15_000 });
		await expect(panel.locator('[data-testid="diagnostics-copy-summary-button"]')).toBeVisible();
		await expect(panel.getByText('Resolution', { exact: true }), 'at-a-glance Resolution stat must be present').toBeVisible();
		// .first(): the label also appears inside an SVG chart tspan.
		await expect(panel.getByText('FPS', { exact: true }).first(), 'at-a-glance FPS stat must be present').toBeVisible();
		artifactDir.writeJson('vwui005-panel-text.json', { panelText: (await panel.innerText()).slice(0, 2000) });

		// Close it; the viewer must still be playing afterwards. The open
		// diagnostics popover intercepts stage hovers, so toggle via the
		// button directly (opacity-0 controls stay clickable) with Escape
		// as fallback.
		const diagBtn = bob.page.locator('[data-testid="open-diagnostics-button"]');
		try {
			await diagBtn.click({ timeout: 5_000 });
		} catch {
			await bob.page.keyboard.press('Escape');
		}
		await expect(panel).toHaveCount(0, { timeout: 15_000 });

		const after = await advancementWindow(bob.page, 5_000);
		artifactDir.writeJson('vwui005-after-close.json', { before, ...after });
		console.log(
			`[VWUI-005] after close: currentTime ${after.a.currentTime} → ${after.b.currentTime} (delta=${after.delta.toFixed(2)})`,
		);
		expect(
			after.delta,
			`viewer must STILL BE PLAYING after closing diagnostics (delta=${after.delta})`,
		).toBeGreaterThan(1);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui005-done');
		artifactDir.writeJson('vwui005-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-006 — most complex scenario: alice AND bob BOTH share into the SAME
// group (StreamSwitcher lists active hosts of the selected group only);
// charlie watches one, switches to the other, and back.
// Timeout follows the MEDIA-006 convention (identical 3-agent topology).
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @media VWUI-006: one viewer switches between two hosts sharing in one group', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(900_000);
	const runTag = `vwui6-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const portA = FIXTURE_PORT_BASE + 6;
	const portB = FIXTURE_PORT_BASE + 7;
	try {
		// Fixture A only at picker time so alice's picker sees exactly one card.
		const fixtureA = await startFixture({ agent: 'media-alice', controlPort: portA });
		ctx.fixtures.push(fixtureA);
		expect(fixtureA.title).toBe('E2E-FIXTURE:MEDIA-ALICE');
		await ensureFixtureCapturable(fixtureA);

		const mesh = await formMediaMesh({
			createAgent,
			profiles,
			runTag,
			includeCharlie: true,
			onAgent: (a) => ctx.agents.push(a),
		});
		const { alice, bob, charlie } = mesh;

		await startFixtureShareViaUi(alice);
		await waitForHostSharing(alice, 45_000, 'alice hostShare (VWUI-006)');

		// NOW start fixture B; bob's picker disambiguates by exact title.
		const fixtureB = await startFixture({ agent: 'media-bob', controlPort: portB });
		ctx.fixtures.push(fixtureB);
		expect(fixtureB.title).toBe('E2E-FIXTURE:MEDIA-BOB');
		await ensureFixtureCapturable(fixtureB);

		await startNamedFixtureShareViaUi(bob, 'E2E-FIXTURE:MEDIA-BOB');
		await waitForHostSharing(bob, 45_000, 'bob hostShare (VWUI-006)');

		// Charlie watches (whichever card the overview lists first — the
		// switcher state below tells us which stream he landed on).
		await watchUntilLive(charlie!, 'charlie video live (initial stream)');

		const switchTrigger = () => charlie!.page.getByRole('button', { name: 'Switch stream' });
		const options = () => charlie!.page.locator('[data-testid="stream-switch-option"]');

		/** Open the switcher and return the host name currently marked Watching. */
		const currentWatchingHost = async (): Promise<string> => {
			// The switcher renders its dropdown only when ≥2 streams are live
			// in the viewer's registry; bob's announcement can land shortly
			// after charlie's initial watch — gate on it before clicking.
			const deadline = Date.now() + 60_000;
			let lastSnap: {
				activeStreams?: Array<{ hostDeviceId?: string }>;
				activeStreamsByGroup?: Record<string, string[]>;
				selectedGroupId?: string | null;
			} | null = null;
			for (;;) {
				lastSnap = await charlie!
					.snapshot<{
						activeStreams?: Array<{ hostDeviceId?: string }>;
						activeStreamsByGroup?: Record<string, string[]>;
						selectedGroupId?: string | null;
					}>()
					.catch(() => null);
				if ((lastSnap?.activeStreams?.length ?? 0) >= 2) break;
				if (Date.now() >= deadline) {
					throw new Error(
						`charlie never saw 2 active streams (last: ${JSON.stringify(lastSnap?.activeStreams?.map((s) => s.hostDeviceId) ?? null)})`,
					);
				}
				await sleep(2_000);
			}
			console.log(
				`[VWUI-006] store state before switcher: selectedGroupId=${JSON.stringify(lastSnap?.selectedGroupId)} activeStreamsByGroup=${JSON.stringify(lastSnap?.activeStreamsByGroup)}`,
			);
			// The dropdown can fail to open when a controls re-render lands
			// between pointerdown and pointerup (auto-hide state churn) —
			// retry the open attempt before concluding anything.
			const root = charlie!.page.locator('[data-testid="stream-switcher-root"]');
			let lastDiag = '';
			for (let attempt = 1; attempt <= 4; attempt++) {
				await revealControls(charlie!.page);
			// After a switch the session re-binds through the phase machine;
			// sample the controller phase while waiting for the control bar
			// to remount so a stuck phase is diagnosable from artifacts.
			const waitStart = Date.now();
			let phaseSamples = '';
			for (;;) {
				const s = await charlie!
					.snapshot<{
						viewerSessions?: Array<{ phase?: string }>;
					}>()
					.catch(() => null);
				const phase = s?.viewerSessions?.[0]?.phase ?? '<none>';
				phaseSamples += `${Math.round((Date.now() - waitStart) / 1000)}s:${phase} `;
				const btn = switchTrigger();
				if (
					(await btn.count()) > 0 &&
					(await btn.isVisible().catch(() => false))
				) {
					break;
				}
				if (Date.now() - waitStart > 60_000) {
					artifactDir.writeJson('vwui006-post-switch-phases.json', { phaseSamples });
					throw new Error(
						`Switch stream button absent 60s after switch; controller phases over time: ${phaseSamples}`,
					);
				}
				await sleep(2_000);
			}
				await switchTrigger().click({ timeout: 15_000 });
				try {
					await root.waitFor({ state: 'visible', timeout: 4_000 });
					break;
				} catch (err) {
					const diag = await charlie!.page
						.evaluate((n: number) => {
							const opts = document.querySelectorAll('[data-testid="stream-switch-option"]').length;
							const tooltip = Array.from(document.querySelectorAll('[role="tooltip"]'))
								.map((t) => t.textContent ?? '')
								.join('|');
							const bar = document.querySelector('[data-testid="video-controls-root"]');
							const trigger = document.querySelector('button[aria-label="Switch stream"]');
							const allTriggers = document.querySelectorAll('button[aria-label="Switch stream"]').length;
							const globalStore = (window as unknown as { __SCREENLINK_STORE__?: { getState?: () => { activeStreamsByGroup?: Record<string, string[]>; selectedGroupId?: string | null } } }).__SCREENLINK_STORE__;
							const storeState = globalStore?.getState?.();
							return {
								attempt: n,
								optionsInDom: opts,
								tooltip,
								triggerFound: trigger !== null,
								allTriggerCount: allTriggers,
								triggerDisabled: trigger instanceof HTMLButtonElement ? trigger.disabled : null,
								// DropdownMenuTrigger sets aria-haspopup="menu"; the
								// single-stream Tooltip branch does not.
								triggerHasPopup: trigger?.getAttribute('aria-haspopup'),
								menusInDom: document.querySelectorAll('[role="menu"]').length,
								auditStoreByGroup: storeState?.activeStreamsByGroup ?? null,
								auditStoreSelected: storeState?.selectedGroupId ?? null,
								controlsBarText: bar ? (bar as HTMLElement).innerText.slice(0, 300) : null,
							};
						}, attempt)
						.catch((e: unknown) => ({ attempt, evaluateError: String(e) }));
					lastDiag = JSON.stringify(diag);
					artifactDir.writeJson(`vwui006-switcher-diag-${diag.attempt ?? attempt}.json`, diag);
					console.warn(`[VWUI-006] switcher did not open on attempt ${attempt} — full diag in artifact`);
					if (attempt === 4) {
						throw new Error(`stream switcher never opened after 4 attempts; last diagnostics: ${lastDiag}`);
					}
					// Escape closes any half-open radix layer before retrying.
					await charlie!.page.keyboard.press('Escape').catch(() => {});
					await sleep(1_500);
				}
			}
			await expect(options()).toHaveCount(2, { timeout: 30_000 });
			const current = options().filter({ hasText: 'Watching' });
			await expect(current).toHaveCount(1, { timeout: 15_000 });
			const text = await current.innerText();
			return text.includes('Bob') ? 'Bob' : 'Alice';
		};

		/** Switch to `targetHost`, confirm the badge moved, confirm fresh media. */
		const switchTo = async (targetHost: string): Promise<void> => {
			const from = await currentWatchingHost();
			expect(targetHost, 'target must differ from current').not.toBe(from);
			console.log(`[VWUI-006] switching ${from} → ${targetHost}`);
			// Heartbeat-driven store updates re-render the menu items every few
			// seconds (element goes "unstable"/detaches mid-click) — retry a
			// force-click until it lands.
			const opt = options().filter({ hasText: targetHost }).first();
			await opt.waitFor({ state: 'visible', timeout: 15_000 });
			for (let clickAttempt = 1; ; clickAttempt++) {
				try {
					await opt.click({ timeout: 4_000, force: true });
					break;
				} catch (e) {
					if (clickAttempt >= 5) throw e;
					await sleep(1_000);
					await opt.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
				}
			}

			// New stream: fresh live video + hard frame-advance evidence.
			await waitForViewerVideoLive(charlie!.page, 90_000, `charlie video live on ${targetHost}'s stream`);
			const win = await advancementWindow(charlie!.page, 5_000);
			artifactDir.writeJson(`vwui006-on-${targetHost.toLowerCase()}.json`, { from, targetHost, ...win });
			console.log(
				`[VWUI-006] on ${targetHost}'s stream: currentTime ${win.a.currentTime} → ${win.b.currentTime} (delta=${win.delta.toFixed(2)})`,
			);
			expect(
				win.delta,
				`fresh advancement required on ${targetHost}'s stream (delta=${win.delta})`,
			).toBeGreaterThan(1);

			// Identity proof: the Watching badge now sits on the target option.
			const watching = await currentWatchingHost();
			artifactDir.writeJson(`vwui006-watching-after-switch-${targetHost.toLowerCase()}.json`, { watching });
			expect(watching, `switcher must mark ${targetHost} as Watching`).toBe(targetHost);
		};

		const firstHost = await currentWatchingHost();
		artifactDir.writeJson('vwui006-initial-stream.json', { firstHost });
		console.log(`[VWUI-006] charlie initially watching ${firstHost}`);
		const otherHost = firstHost === 'Alice' ? 'Bob' : 'Alice';

		await switchTo(otherHost);
		await switchTo(firstHost);
	} finally {
		const cleanup = await runCleanup(
			ctx,
			[portA, portB],
			[profiles.alice, profiles.bob, profiles.charlie],
			'vwui006-done',
		);
		artifactDir.writeJson('vwui006-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control ports must be released').toBe(true);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// VWUI-007
// ─────────────────────────────────────────────────────────────────────────────

test('@media VWUI-007: host stops → viewer ended overlay → exit returns to overview', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `vwui7-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: ViewerTestContext = { fixtures: [], agents: [] };
	const fixturePort = FIXTURE_PORT_BASE + 8;
	try {
		const { alice, bob } = await setupHostShare({ createAgent, runTag, fixturePort, ctx });
		await watchUntilLive(bob, 'bob video live (VWUI-007)');

		// Track uncaught renderer errors for the whole scenario.
		const pageErrors: string[] = [];
		bob.page.on('pageerror', (err) => pageErrors.push(String(err)));

		// Host stops the share through the real confirm dialog.
		const bobMarkers = new MarkerTracker(bob);
		await stopShareViaUi(alice);

		// Viewer reaches the persistent ended overlay with its exit button.
		const endedState = bob.page.locator('[data-testid="viewer-ended-state"]');
		await expect(endedState, 'viewer-ended-state must become visible after host stop').toBeVisible({
			timeout: 60_000,
		});
		const exitButton = bob.page.locator('[data-testid="viewer-exit-button"]');
		await expect(exitButton).toBeVisible({ timeout: 15_000 });
		const endedMarkers = bobMarkers.all();
		artifactDir.writeJson('vwui007-ended.json', {
			endedUiVisible: true,
			markers: endedMarkers,
		});
		console.log(`[VWUI-007] ended overlay visible; markers: ${JSON.stringify(endedMarkers)}`);

		// Exit → back at the group overview, viewer workspace gone.
		await exitButton.click({ timeout: 15_000 });
		await bob.waitForTestId('group-overview-root', 30_000);
		await expect(bob.page.locator('[data-testid="viewer-workspace-root"]')).toHaveCount(0, {
			timeout: 15_000,
		});
		console.log('[VWUI-007] bob back at group-overview-root');

		artifactDir.writeJson('vwui007-page-errors.json', { pageErrors });
		expect(
			pageErrors,
			`no uncaught renderer errors allowed on the viewer (got: ${JSON.stringify(pageErrors)})`,
		).toHaveLength(0);
	} finally {
		const cleanup = await runCleanup(ctx, [fixturePort], [profiles.alice, profiles.bob], 'vwui007-done');
		artifactDir.writeJson('vwui007-cleanup.json', cleanup);
		expect(cleanup.leftovers, `leftover processes: ${JSON.stringify(cleanup.leftovers)}`).toHaveLength(0);
		expect(cleanup.portReleased, 'fixture control port must be released').toBe(true);
	}
});
