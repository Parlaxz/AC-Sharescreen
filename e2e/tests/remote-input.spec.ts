/**
 * remote-input.spec.ts — remote keyboard input over the real host/viewer
 * control channel.  The setup and cleanup deliberately follow the proven
 * viewer-ui/viewer-pause media tests: real fixture capture, real group mesh,
 * and real playback.
 */
import { test, expect } from '../framework/fixtures.js';
import { startFixture, type FixtureHandle } from '../fixtures/fixture-window/client.js';
import {
	makeMediaProfiles,
	formMediaMesh,
	waitForHostSharing,
	startFixtureShareViaUi,
	watchActiveShareViaUi,
	waitForViewerVideoLive,
	sampleViewerVideo,
	mediaSnapshot,
	mediaCleanupChecks,
	ensureFixtureCapturable,
	sleep,
} from './helpers-media.js';
import { MarkerTracker, shutdownAgent } from './helpers-mesh.js';
import type { AgentController } from '../framework/agent.js';

const RUN = `${process.pid}-${Date.now() % 100000}`;
const FIXTURE_PORT = 9870;

interface TestContext {
	fixture: FixtureHandle | null;
	agents: AgentController[];
}

/** Local copy of the established viewer-ui/viewer-pause host-share setup. */
async function setupHostShare(
	createAgent: (name?: string) => Promise<AgentController>,
	ctx: TestContext,
	runTag: string,
): Promise<{ alice: AgentController; bob: AgentController }> {
	const profiles = makeMediaProfiles(runTag);
	const fixture = await startFixture({ agent: 'media-alice', controlPort: FIXTURE_PORT });
	ctx.fixture = fixture;
	await ensureFixtureCapturable(fixture);

	const mesh = await formMediaMesh({
		createAgent,
		profiles,
		runTag,
		includeCharlie: false,
		onAgent: (agent) => ctx.agents.push(agent),
	});

	await startFixtureShareViaUi(mesh.alice);
	await waitForHostSharing(mesh.alice, 45_000, 'alice host share');
	return { alice: mesh.alice, bob: mesh.bob };
}

async function cleanup(
	ctx: TestContext,
	profiles: ReturnType<typeof makeMediaProfiles>,
	artifactDir: { writeJson: (name: string, value: unknown) => void },
): Promise<void> {
	await ctx.fixture?.stop().catch(() => {});
	for (const agent of [...ctx.agents].reverse()) {
		await shutdownAgent(agent, 'remote-input-done');
	}
	const checks = await mediaCleanupChecks({
		fixturePort: FIXTURE_PORT,
		profileNames: [profiles.alice, profiles.bob],
	});
	artifactDir.writeJson('remote-input-cleanup.json', checks);
	expect(checks.leftovers, `leftover processes: ${JSON.stringify(checks.leftovers)}`).toHaveLength(0);
	expect(checks.portReleased, 'fixture control port must be released').toBe(true);
}

test('@media REMOTE-INPUT-001: viewer P sends permitted host Space without local pause', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `remote-input-${RUN}`;
	const profiles = makeMediaProfiles(runTag);
	const ctx: TestContext = { fixture: null, agents: [] };

	try {
		const { alice, bob } = await setupHostShare(createAgent, ctx, runTag);
		await watchActiveShareViaUi(bob);
		const bobMarkers = new MarkerTracker(bob);
		await bobMarkers.waitFor('viewer-watching', 90_000);
		await waitForViewerVideoLive(bob.page, 60_000, 'bob video live (REMOTE-INPUT-001)');

		const hostPermission = alice.page.locator('[data-testid="host-viewer-key-space"]');
		const viewerNotice = bob.page.locator('[data-testid="viewer-remote-input-notice"]');
		const playPause = bob.page.locator('[data-testid="play-pause-button"]');
		const hostViewerRow = alice.page.locator('[data-testid="viewer-row"]').first();

		// Denied by default: the host's Space action is unchecked and the
		// viewer has no remote-key notice.  `p` is the viewer-side simulation
		// key for the host's Space action, so a denied `p` must do nothing.
		await expect(hostPermission).toHaveAttribute('data-state', 'unchecked');
		await expect(viewerNotice).toHaveCount(0);
		await expect(playPause).toHaveAttribute('aria-label', 'Pause stream');
		await bob.page.locator('body').click({ position: { x: 10, y: 10 } });
		await bob.page.keyboard.press('p');
		await expect(playPause).toHaveAttribute('aria-label', 'Pause stream', { timeout: 12_000 });
		await sleep(1_500);

		// Enable Space through the host's real dashboard control and wait for
		// the changed stream announcement to reach the viewer.
		await hostPermission.click();
		await expect(hostPermission).toHaveAttribute('data-state', 'checked');
		await expect
			.poll(async () => {
				const snapshot = await mediaSnapshot(bob);
				return (snapshot?.activeStreams ?? []).some((stream) =>
					(stream.inputPermissions as { space?: unknown } | undefined)?.space === true,
				);
			}, { timeout: 30_000, message: 'viewer stream snapshot must advertise Space permission' })
			.toBe(true);
		await expect(viewerNotice).toBeVisible({ timeout: 30_000 });
		await expect(viewerNotice).toContainText('Viewer keys: P → Space');

		// With permission enabled, viewer `p` sends the host's Space action
		// through viewer.input.request.  It must not fall through to the
		// viewer's local Space pause shortcut; host and viewer must remain in
		// their existing live
		// observable states.
		const before = await sampleViewerVideo(bob.page);
		await bob.page.keyboard.press('p');
		await expect(playPause).toHaveAttribute('aria-label', 'Pause stream', { timeout: 12_000 });
		await expect
			.poll(async () => (await mediaSnapshot(bob))?.viewerSessions?.[0]?.phase ?? null, {
				timeout: 15_000,
				message: 'viewer session must remain watching after permitted Space',
			})
			.toBe('watching');
		await expect(hostViewerRow).toHaveAttribute('data-viewer-state', 'playing', { timeout: 15_000 });

		// Allow the media element a few polling intervals to present fresh
		// frames; a single fixed sample can land between live-track updates.
		await expect
			.poll(async () => (await sampleViewerVideo(bob.page)).currentTime ?? 0, {
				timeout: 15_000,
				intervals: [1_000, 1_500, 2_000],
				message: 'viewer playback must continue after remote Space',
			})
			.toBeGreaterThan((before.currentTime ?? 0) + 0.8);
		const after = await sampleViewerVideo(bob.page);
		artifactDir.writeJson('remote-input-space.json', {
			before,
			after,
			viewerMarkers: bobMarkers.all(),
			hostViewerState: await hostViewerRow.getAttribute('data-viewer-state'),
		});
	} finally {
		await cleanup(ctx, profiles, artifactDir);
	}
});
