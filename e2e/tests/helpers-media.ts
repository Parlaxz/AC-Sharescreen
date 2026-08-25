/**
 * helpers-media — lane-local helpers for media.spec.ts (Phases 4 + 6:
 * real screen-share + real viewer playback with hard media evidence).
 *
 * Everything here is additive: capabilities missing from e2e/framework/*
 * live here instead of editing shared framework code.
 *
 * Product facts relied upon (read-only, never edited):
 * - apps/desktop/src/renderer/services/test-hooks.ts — snapshot()/markers
 *   ring buffer (__screenlinkTestMarkers) and the additive rtcStats() bridge.
 * - apps/desktop/src/renderer/services/share-coordinator.ts —
 *   share-started / share-stopped markers; hostShare snapshot fields.
 * - apps/desktop/src/renderer/services/viewer-session-controller.ts —
 *   viewer-joined / viewer-watching / viewer-reconnecting / viewer-ended
 *   markers; phase names idle|connecting|watching|paused|reconnecting|
 *   ended|error.
 * - apps/desktop/src/main/stream-toast-manager.ts + test-markers.ts —
 *   toast-shown markers are MAIN-process only (<userData>/logs/
 *   e2e-markers.log), never in the renderer ring buffer.
 * - e2e/fixtures/fixture-window/client.ts — startFixture({agent}) → title
 *   exactly "E2E-FIXTURE:<AGENT>" which ShareSetup source cards expose via
 *   data-source-title.
 */
import type { Page } from '@playwright/test';
import type { AgentController } from '../framework/agent.js';
import type { FixtureHandle } from '../fixtures/fixture-window/client.js';
import { waitFor, sleep } from '../framework/wait.js';
import { assertNoLeftovers } from '../framework/processes.js';
import {
	setDisplayNameViaSettings,
	createGroupViaUi,
	joinGroupViaUi,
	waitForAllMembersOnline,
	onlineExpectation,
	selectGroupViaRail,
	waitForGroupOverview,
	safeSnapshot,
	closeGracefullyBounded,
} from './helpers-mesh.js';
import { readMainMarkers } from './helpers-lc.js';

export { sleep, waitFor };

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface MediaProfiles {
	alice: string;
	bob: string;
	charlie: string;
}

/** Unique-per-run 'media-*' profile triple (task rule: prefix media-*). */
export function makeMediaProfiles(runTag: string): MediaProfiles {
	return {
		alice: `media-alice-${runTag}`,
		bob: `media-bob-${runTag}`,
		charlie: `media-charlie-${runTag}`,
	};
}

// ---------------------------------------------------------------------------
// Snapshot shapes (defensive)
// ---------------------------------------------------------------------------

export interface HostShareSnapshot {
	sharing?: boolean;
	sessionId?: string | null;
	mediaSessionId?: string | null;
	sourceLabel?: string | null;
}

export interface MediaSnapshot {
	currentPage?: string;
	selectedGroupId?: string | null;
	activeStreams?: Array<Record<string, unknown>>;
	viewerSessions?: Array<{
		phase?: string;
		sessionId?: string | null;
		groupId?: string | null;
		error?: string | null;
	}>;
	hostShare?: HostShareSnapshot | null;
	[key: string]: unknown;
}

export async function mediaSnapshot(
	agent: AgentController,
): Promise<MediaSnapshot | null> {
	return safeSnapshot(agent) as Promise<MediaSnapshot | null>;
}

/** activeStreams entries scoped to one group (StreamAnnouncement.groupId). */
export function streamsForGroup(
	snap: MediaSnapshot | null,
	groupId: string,
): Array<Record<string, unknown>> {
	return (snap?.activeStreams ?? []).filter(
		(s) => (s as { groupId?: unknown }).groupId === groupId,
	);
}

/**
 * Poll until the agent's hostShare reports sharing===true with non-empty
 * sessionId AND mediaSessionId. Returns the final hostShare object.
 */
export async function waitForHostSharing(
	agent: AgentController,
	timeoutMs: number,
	label: string,
): Promise<HostShareSnapshot> {
	let last: MediaSnapshot | null = null;
	return waitFor(
		async () => {
			last = await mediaSnapshot(agent);
			const hs = last?.hostShare ?? null;
			if (
				hs &&
				hs.sharing === true &&
				typeof hs.sessionId === 'string' &&
				hs.sessionId.length > 0 &&
				typeof hs.mediaSessionId === 'string' &&
				hs.mediaSessionId.length > 0
			) {
				return hs;
			}
			return null;
		},
		{ timeout: timeoutMs, interval: 1_000, label },
	).catch((err) => {
		throw new Error(
			`${String(err)}\n  last snapshot.hostShare: ${JSON.stringify(last?.hostShare ?? null)}\n` +
				`  last snapshot.viewerSessions: ${JSON.stringify(last?.viewerSessions ?? null)}`,
		);
	});
}

// ---------------------------------------------------------------------------
// rtcStats bridge (PART A extension on window.__screenlinkTest)
// ---------------------------------------------------------------------------

export interface RtcStatsResult {
	connections?: Array<{
		label?: string;
		pcPresent?: boolean;
		inbound?: Array<Record<string, unknown>>;
		outbound?: Array<Record<string, unknown>>;
		error?: string;
	}>;
	error?: string;
}

/**
 * Call the additive window.__screenlinkTest.rtcStats() bridge. Never throws:
 * a missing bridge surfaces as { error: 'rtcStats bridge unavailable' } so
 * MEDIA-003 can degrade gracefully per its contract. The bridge returns a
 * top-level ARRAY of connection summaries (or {error}); both are normalized
 * into { connections: [...] } here.
 */
export async function sampleRtcStats(
	agent: AgentController,
): Promise<RtcStatsResult> {
	try {
		const raw = (await agent.page.evaluate(() => {
			const hooks = (
				globalThis as unknown as Record<string, any>
			).__screenlinkTest;
			if (!hooks || typeof hooks.rtcStats !== 'function') {
				return { error: 'rtcStats bridge unavailable' };
			}
			return hooks.rtcStats();
		})) as RtcStatsResult | Array<NonNullable<RtcStatsResult['connections']>[number]>;
		if (Array.isArray(raw)) return { connections: raw };
		return raw;
	} catch (err) {
		return { error: `evaluate failed: ${String(err)}` };
	}
}

// ---------------------------------------------------------------------------
// Viewer <video> sampling (frame-advance proof)
// ---------------------------------------------------------------------------

export interface VideoSample {
	present: boolean;
	readyState?: number;
	videoWidth?: number;
	videoHeight?: number;
	currentTime?: number;
	/** Cumulative requestVideoFrameCallback count since first sample (null when rVFC unavailable). */
	rvfc?: number | null;
}

/**
 * Sample the viewer <video> element. On the FIRST call this also installs a
 * requestVideoFrameCallback counter on window (when the API exists) that
 * increments once per presented frame; later samples read the cumulative
 * count, giving hard frame-advance evidence beyond currentTime.
 */
export async function sampleViewerVideo(page: Page): Promise<VideoSample> {
	return page.evaluate(() => {
		const g = globalThis as unknown as Record<string, unknown>;
		const video = document.querySelector<HTMLVideoElement>(
			'video[data-testid="viewer-video"]',
		);
		if (!video) return { present: false } satisfies VideoSample;
		if (
			typeof video.requestVideoFrameCallback === 'function' &&
			!g.__mediaRvfcInstalled
		) {
			g.__mediaRvfcInstalled = true;
			g.__mediaRvfcCount = 0;
			const cb = () => {
				g.__mediaRvfcCount = ((g.__mediaRvfcCount as number) ?? 0) + 1;
				video.requestVideoFrameCallback(cb);
			};
			video.requestVideoFrameCallback(cb);
		}
		return {
			present: true,
			readyState: video.readyState,
			videoWidth: video.videoWidth,
			videoHeight: video.videoHeight,
			currentTime: video.currentTime,
			rvfc: typeof g.__mediaRvfcCount === 'number' ? g.__mediaRvfcCount : null,
		} satisfies VideoSample;
	});
}

/** Wait until the viewer video element reports live playable dimensions. */
export async function waitForViewerVideoLive(
	page: Page,
	timeoutMs: number,
	label: string,
): Promise<VideoSample> {
	return waitFor(
		async () => {
			const s = await sampleViewerVideo(page);
			if (
				s.present &&
				(s.readyState ?? 0) >= 3 &&
				(s.videoWidth ?? 0) > 0 &&
				(s.videoHeight ?? 0) > 0
			) {
				return s;
			}
			return null;
		},
		{ timeout: timeoutMs, interval: 1_000, label },
	);
}

// ---------------------------------------------------------------------------
// Main-process toast markers (toast-shown lives ONLY in the marker file)
// ---------------------------------------------------------------------------

/** Read toast-shown entries from the agent's main-process marker file. */
export async function readToastShownMarkers(
	agent: AgentController,
): Promise<Array<{ timestamp?: string; e2eMarker: string; [k: string]: unknown }>> {
	const userDataPath = await agent.mainEval((electron) =>
		electron.app.getPath('userData'),
	);
	return readMainMarkers(userDataPath).filter((m) => m.e2eMarker === 'toast-shown');
}

/** BrowserWindow.getAllWindows().length via the real main process. */
export async function mainWindowCount(agent: AgentController): Promise<number> {
	return agent.mainEval(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

// ---------------------------------------------------------------------------
// Share UI flows (real picker path — no mocks, no getDisplayMedia stubs)
// ---------------------------------------------------------------------------

/**
 * Start a share through the REAL ShareSetup picker:
 * start-share-button → share-setup-root → Window tab → the fixture card
 * (data-source-title starting 'E2E-FIXTURE:') → audio mode 'none'
 * (values inspected from the actual RadioGroup first) → start-sharing-button
 * → host-dashboard-root.
 */
export async function startFixtureShareViaUi(
	agent: AgentController,
	opts: { setupTimeoutMs?: number; dashboardTimeoutMs?: number } = {},
): Promise<void> {
	const setupTimeoutMs = opts.setupTimeoutMs ?? 30_000;
	await agent.clickTestId('start-share-button', 20_000);
	await agent.waitForTestId('share-setup-root', setupTimeoutMs);

	// Real picker path: switch to the Window tab, then click THE fixture card.
	await agent.clickTestId('source-tab-window', 15_000);
	const fixtureCard = agent.page.locator(
		'[data-testid="source-card"][data-source-title^="E2E-FIXTURE:"]',
	);
	try {
		await fixtureCard.first().waitFor({ state: 'visible', timeout: setupTimeoutMs });
	} catch (err) {
		// Rich diagnostics: which cards ARE rendered, which tab is active,
		// did the sources fetch fail, and is the fixture even alive?
		const diag = await agent.page
			.evaluate(() => ({
				cards: Array.from(
					document.querySelectorAll('[data-testid="source-card"]'),
				).map((el) => ({
					title: el.getAttribute('data-source-title'),
					id: el.getAttribute('data-source-id'),
				})),
				activeTab: document
					.querySelector('[data-testid="source-tab-window"]')
					?.getAttribute('aria-selected'),
				setupError: document.querySelector('[data-testid="share-setup-error"]')
					?.textContent ?? null,
			}))
			.catch((e) => ({ evaluateFailed: String(e) }));
		throw new Error(
			`${agent.name}: fixture source card not visible within ${setupTimeoutMs}ms — ` +
				`picker diagnostics: ${JSON.stringify(diag)} (underlying: ${String(err).split('\n')[0]})`,
		);
	}
	await fixtureCard.first().click({ timeout: 10_000 });

	// Audio mode: inspect the ACTUAL RadioGroup values before selecting.
	const radioValues = await agent.page
		.locator('[data-testid="audio-mode-select"] [role="radio"]')
		.evaluateAll((els) =>
			els.map((el) => ({
				value: el.getAttribute('value'),
				checked: el.getAttribute('aria-checked'),
			})),
		);
	console.log(`[helpers-media] ${agent.name}: audio-mode radio values: ${JSON.stringify(radioValues)}`);
	const noneRadio = agent.page.locator(
		'[data-testid="audio-mode-select"] [role="radio"][value="none"]',
	);
	if ((await noneRadio.count()) === 0) {
		throw new Error(
			`${agent.name}: audio-mode-select has no 'none' option; observed values: ${JSON.stringify(radioValues)}`,
		);
	}
	await noneRadio.click({ timeout: 10_000 });

	await agent.clickTestId('start-sharing-button', 20_000);
	await agent.waitForTestId(
		'host-dashboard-root',
		opts.dashboardTimeoutMs ?? 60_000,
	);
}

/** Stop the share through the real confirm dialog. */
export async function stopShareViaUi(agent: AgentController): Promise<void> {
	await agent.clickTestId('stop-sharing-button', 20_000);
	await agent.waitForTestId('stop-confirm-dialog', 15_000);
	await agent.clickTestId('stop-confirm-button', 15_000);
}

/** Open the group overview's active share card and press Watch. */
export async function watchActiveShareViaUi(
	agent: AgentController,
	timeoutMs = 45_000,
	/** Disambiguates when several hosts share simultaneously (card text match). */
	hostName?: string,
): Promise<void> {
	if (hostName) {
		const card = agent.page
			.locator('[data-testid="active-share-card"]')
			.filter({ hasText: hostName })
			.first();
		await card.waitFor({ state: 'visible', timeout: timeoutMs });
		await card.getByTestId('watch-stream-button').click({ timeout: 15_000 });
		return;
	}
	// First-card basis: identical behavior with one share, and tolerant of
	// several simultaneous shares when no disambiguation was requested.
	const card = agent.page.locator('[data-testid="active-share-card"]').first();
	await card.waitFor({ state: 'visible', timeout: timeoutMs });
	await card.getByTestId('watch-stream-button').click({ timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Mesh formation (reuses the mesh-lane primitives incl. the documented
// membership-propagation workaround for the flaky 3rd joiner)
// ---------------------------------------------------------------------------

export interface MediaMeshHandles {
	alice: AgentController;
	bob: AgentController;
	charlie: AgentController | null;
	groupId: string;
	groupName: string;
	inviteLink: string;
}

/**
 * Form the canonical media mesh: alice creates the group, bob (+ optionally
 * charlie) join via invite. Every agent ends on the group overview with full
 * membership visible/online. Delegates to the mesh lane's proven formation
 * (which restarts a non-converged agent ONCE — documented product-defect
 * workaround for ~50% third-joiner propagation flakiness).
 */
export async function formMediaMesh(opts: {
	createAgent: (name?: string) => Promise<AgentController>;
	profiles: MediaProfiles;
	runTag: string;
	includeCharlie?: boolean;
	memberTimeoutMs?: number;
	onAgent?: (agent: AgentController) => void;
}): Promise<MediaMeshHandles> {
	const { createAgent, profiles, runTag } = opts;
	const includeCharlie = opts.includeCharlie !== false;
	const memberTimeoutMs = opts.memberTimeoutMs ?? 100_000;
	const groupName = `Media ${runTag}`;

	let alice = await createAgent(profiles.alice);
	opts.onAgent?.(alice);
	await alice.waitForTestId('app-root', 60_000);
	await setDisplayNameViaSettings(alice, 'Alice');
	const { groupId, inviteLink } = await createGroupViaUi(alice, groupName);

	let bob = await createAgent(profiles.bob);
	opts.onAgent?.(bob);
	await bob.waitForTestId('app-root', 60_000);
	await setDisplayNameViaSettings(bob, 'Bob');
	await joinGroupViaUi(bob, inviteLink);

	let charlie: AgentController | null = null;
	if (includeCharlie) {
		charlie = await createAgent(profiles.charlie);
		opts.onAgent?.(charlie);
		await charlie.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(charlie, 'Charlie');
		await joinGroupViaUi(charlie, inviteLink);
	}

	const everyone: Array<{ agent: AgentController; name: string; profile: string }> = [
		{ agent: alice, name: 'Alice', profile: profiles.alice },
		{ agent: bob, name: 'Bob', profile: profiles.bob },
	];
	if (charlie) everyone.push({ agent: charlie, name: 'Charlie', profile: profiles.charlie });
	const allNames = everyone.map((e) => e.name);

	for (let i = 0; i < everyone.length; i++) {
		const entry = everyone[i]!;
		await waitForAllMembersOnline(
			entry.agent,
			onlineExpectation(entry.name, allNames),
			memberTimeoutMs,
			`${entry.agent.name}: ${allNames.length} member rows, remotes online`,
			{ nudge: true },
		).catch(async (err) => {
			// Documented defect workaround (see helpers-mesh.formMesh): restart
			// the lagging agent once to heal membership via fresh handshakes.
			console.warn(
				`[formMediaMesh] KNOWN DEFECT (membership propagation): ${entry.agent.name} did not converge ` +
					`(${String(err).split('\n')[0]}); restarting once to self-heal`,
			);
			await closeGracefullyBounded(entry.agent, `formMediaMesh-restart:${entry.name}`);
			const restarted = await createAgent(entry.profile);
			opts.onAgent?.(restarted);
			await restarted.waitForTestId('app-root', 60_000);
			await selectGroupViaRail(restarted, groupName);
			await waitForGroupOverview(restarted, 45_000);
			await waitForAllMembersOnline(
				restarted,
				onlineExpectation(entry.name, allNames),
				memberTimeoutMs,
				`${restarted.name}(restarted): ${allNames.length} member rows, remotes online`,
				{ nudge: true },
			);
			entry.agent = restarted;
			if (entry.name === 'Alice') alice = restarted;
			else if (entry.name === 'Bob') bob = restarted;
			else if (charlie && entry.name === 'Charlie') charlie = restarted;
		});
	}

	return { alice, bob, charlie, groupId, groupName, inviteLink };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * OBSERVED ENVIRONMENT QUIRK (documented, worked around): a freshly created
 * fixture BrowserWindow is NOT enumerated by desktopCapturer.getSources()
 * on this machine until it goes through a restore/show cycle — the probe
 * artifact dev-media/probe-run.log shows the window absent from immediate
 * enumeration and present after fixture.restore(). Calling restore() once
 * right after startFixture makes the picker able to see the source.
 */
export async function ensureFixtureCapturable(fixture: FixtureHandle): Promise<void> {
	await fixture.restore();
	await sleep(1_000);
}

/**
 * Final cleanup: stop fixture, verify no leftover processes for the given
 * profile names, and verify the fixture control port was released.
 */
export async function mediaCleanupChecks(opts: {
	fixturePort: number | null;
	profileNames: string[];
}): Promise<{ leftovers: Awaited<ReturnType<typeof assertNoLeftovers>>; portReleased: boolean }> {
	const leftovers = await assertNoLeftovers(opts.profileNames);
	let portReleased = true;
	if (opts.fixturePort !== null) {
		try {
			const res = await fetch(`http://127.0.0.1:${opts.fixturePort}/frame`, {
				signal: AbortSignal.timeout(2_000),
			});
			// Any HTTP response means something still listens on the port.
			portReleased = false;
			void res.body?.cancel().catch(() => {});
		} catch {
			portReleased = true;
		}
	}
	return { leftovers, portReleased };
}
