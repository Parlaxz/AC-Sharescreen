/**
 * helpers-mesh — lane-local helpers for mesh.spec.ts (Phase 3:
 * multi-agent mesh / membership / recovery scenarios).
 *
 * Everything here is additive: capabilities missing from e2e/framework/*
 * live here instead of editing shared framework code.
 *
 * Product facts relied upon (read-only, never edited):
 * - apps/desktop/src/renderer/services/test-hooks.ts — snapshot()/markers.
 * - apps/desktop/src/renderer/services/group-connection-manager.ts —
 *   ConnectionState union "idle"|"starting"|"connected"|"reconnecting"|
 *   "stopping"|"destroyed"|"failed"; emitMarker("group-connected"/...
 *   "group-disconnected"); failed connections auto-retry with capped backoff.
 * - apps/desktop/src/renderer/services/initialize-app-runtime.ts — persisted
 *   groups auto-connect at startup and the first one is auto-selected
 *   (currentPage becomes "overview").
 * - apps/desktop/src/main/group-store.ts — persistence at
 *   <userData>/groups.json (array of LocalGroupRecord with
 *   sharedState.members keyed by deviceId).
 * - packages/shared/src/device-identity.ts — dev display names only map for
 *   exact profiles "alice"/"bob"/"charlie"; arbitrary profile suffixes stay
 *   "Host", so these tests SET display names explicitly via the real
 *   Settings UI before any group create/join.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { AgentController } from '../framework/agent.js';
import { waitFor, sleep } from '../framework/wait.js';
import { killTree, waitForProcessGone, isPidAlive } from '../framework/processes.js';
import { parseGroupInviteLink } from '../../packages/shared/src/group-link.js';

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface MeshProfiles {
	alice: string;
	bob: string;
	charlie: string;
}

/** Unique-per-run profile triple; relaunches reuse the SAME string deliberately. */
export function makeProfiles(runTag: string): MeshProfiles {
	return {
		alice: `m-alice-${runTag}`,
		bob: `m-bob-${runTag}`,
		charlie: `m-charlie-${runTag}`,
	};
}

// ---------------------------------------------------------------------------
// Connection-state model (mirrors group-control-connection.ts ConnectionState)
// ---------------------------------------------------------------------------

export const CONNECTION_STATES = [
	'idle',
	'starting',
	'connected',
	'reconnecting',
	'stopping',
	'destroyed',
	'failed',
] as const;

// ---------------------------------------------------------------------------
// Snapshot shapes (defensive — fields optional)
// ---------------------------------------------------------------------------

export interface GroupConnectionSnapshotEntry {
	groupId?: string;
	state?: string;
	onlinePeers?: string[];
	error?: string | null;
}

export interface MeshSnapshot {
	currentPage?: string;
	selectedGroupId?: string | null;
	groups?: Array<{ id?: string; name?: string; memberCount?: number }>;
	groupConnections?: GroupConnectionSnapshotEntry[];
	activeStreams?: Array<Record<string, unknown>>;
	viewerSessions?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

/** Snapshot that never throws; returns null when hooks are unavailable. */
export async function safeSnapshot(agent: AgentController): Promise<MeshSnapshot | null> {
	try {
		return await agent.snapshot<MeshSnapshot | null>();
	} catch {
		return null;
	}
}

/** All groupConnection entries for one groupId (defensive against shape drift). */
export function connectionsFor(
	snap: MeshSnapshot | null,
	groupId: string,
): GroupConnectionSnapshotEntry[] {
	const all = snap?.groupConnections ?? [];
	return all.filter((c) => c && c.groupId === groupId);
}

// ---------------------------------------------------------------------------
// Invite parsing (relative import of the shared group-link module)
// ---------------------------------------------------------------------------

/** Extract the groupId from a screenlink://group invite link. */
export function inviteGroupId(link: string): string {
	const parsed = parseGroupInviteLink(link.trim());
	if (!parsed) {
		throw new Error(`inviteGroupId: could not parse invite link: ${link.slice(0, 80)}...`);
	}
	return parsed.groupId;
}

// ---------------------------------------------------------------------------
// Markers
//
// OBSERVED FRAMEWORK GAP: AgentController.drainMarkers() reads
// window.__screenlinkMarkers, but test-hooks.ts installs the ring buffer as
// window.__screenlinkTestMarkers — so the ring-buffer half of drainMarkers
// always returns [] and console capture is empty in this environment (see
// flushed sanity logs: 0 renderer entries). The ring buffer IS readable
// directly, so this tracker polls __screenlinkTestMarkers.all() and falls
// back to drainMarkers() for whatever console capture manages to see.
// ---------------------------------------------------------------------------

export class MarkerTracker {
	private seen: Array<{ t: number; marker: string }> = [];
	private keys = new Set<string>();

	constructor(private readonly agent: AgentController) {}

	private absorb(entries: Array<{ t?: number; marker?: string; e2eMarker?: string }>): void {
		for (const m of entries) {
			const name =
				typeof m.e2eMarker === 'string'
					? m.e2eMarker
					: typeof m.marker === 'string'
						? m.marker
						: null;
			if (!name) continue;
			const key = `${name}:${m.t ?? ''}`;
			if (this.keys.has(key)) continue;
			this.keys.add(key);
			this.seen.push({ t: typeof m.t === 'number' ? m.t : Date.now(), marker: name });
		}
	}

	/** Drain whatever is pending now into the accumulator. */
	async drain(): Promise<void> {
		try {
			const ring = await this.agent.page.evaluate(() => {
				const rb = (
					globalThis as unknown as Record<string, any>
				).__screenlinkTestMarkers;
				return rb && typeof rb.all === 'function' ? rb.all() : [];
			});
			this.absorb(ring);
		} catch {
			/* page may be mid-navigation */
		}
		try {
			const drained = await this.agent.drainMarkers();
			this.absorb(drained);
		} catch {
			/* ignore */
		}
	}

	has(name: string): boolean {
		return this.seen.some((m) => m.marker === name);
	}

	count(name: string): number {
		return this.seen.filter((m) => m.marker === name).length;
	}

	/** Poll until the marker appears (draining as we go). Returns elapsed ms, or -1 on timeout. */
	async waitFor(name: string, timeoutMs: number): Promise<number> {
		const start = Date.now();
		for (;;) {
			if (this.has(name)) return Date.now() - start;
			await this.drain();
			if (this.has(name)) return Date.now() - start;
			if (Date.now() - start >= timeoutMs) return -1;
			await sleep(1_000);
		}
	}

	all(): Array<{ t: number; marker: string }> {
		return [...this.seen];
	}
}

// ---------------------------------------------------------------------------
// Member rows ([data-testid=member-row] with data-member-name/data-online)
// ---------------------------------------------------------------------------

export interface MemberRow {
	name: string | null;
	online: string | null;
}

export async function readMemberRows(agent: AgentController): Promise<MemberRow[]> {
	return agent.page.evaluate(() => {
		return Array.from(
			document.querySelectorAll('[data-testid="member-row"]'),
		).map((el) => ({
			name: el.getAttribute('data-member-name'),
			online: el.getAttribute('data-online'),
		}));
	});
}

/**
 * Labeled wait until the members-list shows EXACTLY `expectation.totalRows`
 * rows and every member in `expectation.mustBeOnline` reports
 * data-online="true".
 *
 * PRODUCT FACT: the local device IS marked online once its group control
 * connection is connected, so the self row is required online too
 * (`mustBeOnline` = allNames).
 */
export interface OnlineExpectation {
	totalRows: number;
	mustBeOnline: string[];
}

// selfName kept for call-site compatibility; self must now be online too.
export function onlineExpectation(selfName: string, allNames: string[]): OnlineExpectation {
	return {
		totalRows: allNames.length,
		mustBeOnline: allNames,
	};
}

export async function waitForAllMembersOnline(
	agent: AgentController,
	expectation: OnlineExpectation,
	timeoutMs: number,
	label: string,
	opts: { nudge?: boolean } = {},
): Promise<MemberRow[]> {
	let lastNudge = -Infinity;
	const startedAt = Date.now();
	try {
		return await waitFor(
			async () => {
				// Recurring nudge via the REAL "Refresh group state" button
				// (GroupOverview → requestSync): membership anti-entropy
				// otherwise only runs every 30s, and a missed propagation
				// round can otherwise never self-heal within the budget.
				if (
					opts.nudge &&
					timeoutMs > 30_000 &&
					Date.now() - startedAt - lastNudge >= 40_000
				) {
					lastNudge = Date.now() - startedAt;
					try {
						await agent.clickTestId('refresh-group-button', 5_000);
					} catch {
						/* button may not be on screen — best effort */
					}
				}
				const rows = await readMemberRows(agent);
				if (rows.length !== expectation.totalRows) return null;
				for (const name of expectation.mustBeOnline) {
					const row = rows.find((r) => r.name === name);
					if (!row || row.online !== 'true') return null;
				}
				return rows;
			},
			{ timeout: timeoutMs, interval: 2_000, label },
		);
	} catch (err) {
		// Enrich the timeout with the live renderer state for diagnosis.
		const rows = await readMemberRows(agent).catch(() => '<read failed>');
		const snap = await safeSnapshot(agent);
		throw new Error(
			`${String(err)}\n` +
				`  observed member rows: ${JSON.stringify(rows)}\n` +
				`  snapshot.groupConnections: ${JSON.stringify(snap?.groupConnections ?? null)}\n` +
				`  snapshot.groups: ${JSON.stringify(snap?.groups ?? null)}`,
		);
	}
}

/**
 * Labeled wait until the member named `memberName` reports
 * data-online="false". Returns the elapsed ms (eventual-consistency latency).
 */
export async function waitForMemberOffline(
	agent: AgentController,
	memberName: string,
	timeoutMs: number,
	label: string,
): Promise<number> {
	const start = Date.now();
	await waitFor(
		async () => {
			const rows = await readMemberRows(agent);
			const row = rows.find((r) => r.name === memberName);
			return row && row.online === 'false' ? row : null;
		},
		{ timeout: timeoutMs, interval: 2_000, label },
	);
	return Date.now() - start;
}

// ---------------------------------------------------------------------------
// Navigation helpers (testid/role selectors only)
//
// Live routing reality (apps/desktop/src/renderer/App.tsx renderPage):
// - "home"    → routes/HomePage.tsx (group grid WITHOUT data-group-id;
//               its Create/Join buttons carry no testids)
// - "overview"→ GroupOverview (group-overview-root, members-list)
// - "group-settings" → GroupSettingsPage
// GroupsWorkspace.tsx (with groups-create-button etc.) only renders for
// currentPage === "viewer" — i.e. never in these scenarios. Create/Join
// dialogs are global (App.tsx) and opened via the shared store flag; the
// stable entry point is the GroupRail "Create or join group" dropdown.
// ---------------------------------------------------------------------------

/** Set the local display name through the REAL Settings UI (LIF-005 path). */
export async function setDisplayNameViaSettings(
	agent: AgentController,
	displayName: string,
): Promise<void> {
	await agent.clickTestId('nav-settings', 30_000);
	await agent.waitForTestId('settings-root', 30_000);
	await agent.fillTestId('settings-display-name-input', displayName);
	await agent.page.getByRole('button', { name: 'Save settings' }).click();
	await agent.waitForTestId('settings-save-feedback', 15_000);
	await agent.clickTestId('nav-home', 15_000);
}

/** Open the shared Create-group dialog via the rail dropdown. */
export async function openCreateGroupDialog(agent: AgentController): Promise<void> {
	await agent.page
		.getByRole('button', { name: 'Create or join group' })
		.click({ timeout: 15_000 });
	await agent.page
		.getByRole('menuitem', { name: 'Create group' })
		.click({ timeout: 10_000 });
	await agent.waitForTestId('create-group-dialog', 10_000);
}

/** Open the shared Join-group dialog via the rail dropdown. */
export async function openJoinGroupDialog(agent: AgentController): Promise<void> {
	await agent.page
		.getByRole('button', { name: 'Create or join group' })
		.click({ timeout: 15_000 });
	await agent.page
		.getByRole('menuitem', { name: 'Join group' })
		.click({ timeout: 10_000 });
	await agent.waitForTestId('join-group-dialog', 10_000);
}

/**
 * Select a group via its rail icon (aria-label "Group: <name>") and wait
 * until the group overview page renders.
 */
export async function selectGroupViaRail(
	agent: AgentController,
	groupName: string,
): Promise<void> {
	const btn = agent.page.getByRole('button', { name: `Group: ${groupName}` });
	await btn.waitFor({ state: 'visible', timeout: 15_000 });
	await btn.click({ timeout: 5_000 });
}

/** Wait until the group overview page for the currently selected group renders. */
export async function waitForGroupOverview(
	agent: AgentController,
	timeoutMs = 30_000,
): Promise<void> {
	await agent.waitForTestId('group-overview-root', timeoutMs);
}

/**
 * Assert a group survived a restart ("group-card persists"): the rail shows
 * the group and the renderer store knows it. Returns the snapshot.
 */
export async function expectGroupPersisted(
	agent: AgentController,
	groupId: string,
	groupName: string,
): Promise<MeshSnapshot | null> {
	const railBtn = agent.page.getByRole('button', { name: `Group: ${groupName}` });
	await railBtn.waitFor({ state: 'visible', timeout: 30_000 });
	const snap = await safeSnapshot(agent);
	const known = (snap?.groups ?? []).some((g) => g.id === groupId);
	if (!known) {
		throw new Error(
			`agent "${agent.name}": group ${groupId} missing from snapshot.groups: ${JSON.stringify(snap?.groups)}`,
		);
	}
	return snap;
}

// ---------------------------------------------------------------------------
// Group create/join building blocks
// ---------------------------------------------------------------------------

/** Clear the system clipboard so invite-link polling cannot read stale data. */
export async function clearClipboard(agent: AgentController): Promise<void> {
	await agent.mainEval(({ clipboard }) => clipboard.writeText(''));
}

/** Poll the clipboard until it holds a screenlink://group invite link. */
export async function readInviteFromClipboard(
	agent: AgentController,
	timeoutMs = 15_000,
): Promise<string> {
	return waitFor(
		async () => {
			const text = await agent.clipboardText();
			return text.startsWith('screenlink://group?v=1&data=') ? text : null;
		},
		{ timeout: timeoutMs, interval: 500, label: `invite link on ${agent.name} clipboard` },
	);
}

/**
 * Create a group through the real UI and return {groupId, inviteLink}.
 * Leaves the agent on the new group's overview page.
 *
 * Invite acquisition uses the overview's real "Invite" button
 * (GroupOverview.tsx invite-button → copyGroupInviteFromUi → preload
 * getGroupInvite + clipboardWriteText); createGroupAction itself does NOT
 * write the clipboard.
 */
export async function createGroupViaUi(
	agent: AgentController,
	groupName: string,
): Promise<{ groupId: string; inviteLink: string }> {
	await clearClipboard(agent);
	await openCreateGroupDialog(agent);
	await agent.fillTestId('create-group-name-input', groupName);
	await agent.clickTestId('create-group-submit', 15_000);
	await waitForGroupOverview(agent, 45_000);
	await agent.clickTestId('invite-button', 15_000);
	const inviteLink = await readInviteFromClipboard(agent);
	return { groupId: inviteGroupId(inviteLink), inviteLink };
}

/** Join a group through the real UI. Leaves the agent on the group overview. */
export async function joinGroupViaUi(
	agent: AgentController,
	inviteLink: string,
): Promise<void> {
	await openJoinGroupDialog(agent);
	await agent.fillTestId('join-invite-input', inviteLink);
	await agent.clickTestId('join-group-submit', 15_000);
	await waitForGroupOverview(agent, 60_000);
}

// ---------------------------------------------------------------------------
// Mesh formation
// ---------------------------------------------------------------------------

export interface MeshHandles {
	alice: AgentController;
	bob: AgentController;
	charlie: AgentController | null;
	groupId: string;
	groupName: string;
	inviteLink: string;
}

/**
 * Form the canonical mesh: alice creates the group, bob (+ optionally
 * charlie) join via the invite link. Every agent ends on the group overview
 * with the full membership visible and online.
 */
export async function formMesh(opts: {
	createAgent: (name?: string) => Promise<AgentController>;
	profiles: MeshProfiles;
	runTag: string;
	includeCharlie?: boolean;
	memberTimeoutMs?: number;
	/** Called as soon as each agent exists so tests can shut them down in
	 * `finally` even when formation itself fails. */
	onAgent?: (agent: AgentController) => void;
}): Promise<MeshHandles> {
	const { createAgent, profiles, runTag } = opts;
	const includeCharlie = opts.includeCharlie !== false;
	const memberTimeoutMs = opts.memberTimeoutMs ?? 100_000;
	const groupName = `Mesh ${runTag}`;

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

	/**
	 * Formation SAFETY NET: a non-converged agent is restarted ONCE to heal
	 * via fresh handshakes + full-state request. This covers transient
	 * discovery loss only — the runtime now rejoins the room on its own when
	 * it stays peerless >45s, so persistent stalls here should be treated as
	 * product regressions.
	 */
	for (let i = 0; i < everyone.length; i++) {
		const entry = everyone[i]!;
		try {
			await waitForAllMembersOnline(
				entry.agent,
				onlineExpectation(entry.name, allNames),
				memberTimeoutMs,
				`${entry.agent.name}: ${allNames.length} member rows, remotes online`,
				{ nudge: true },
			);
		} catch (err) {
			console.warn(
				`[formMesh] DEFECT SUSPECT: membership did not converge on ${entry.agent.name} ` +
					`(${String(err).split('\n')[0]}); restarting the agent once to heal via fresh handshakes`,
			);
			await closeGracefullyBounded(entry.agent, `formMesh-restart:${entry.name}`);
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
			if (entry.name === 'Bob') bob = restarted;
			if (entry.name === 'Charlie') charlie = restarted;
		}
	}

	return { alice, bob, charlie, groupId, groupName, inviteLink };
}

// ---------------------------------------------------------------------------
// Diagnostics / assertions support
// ---------------------------------------------------------------------------

/**
 * Robust agent shutdown with a bounded graceful phase.
 *
 * OBSERVED PRODUCT/FRAMEWORK BEHAVIOR: AgentController.close() (graceful
 * electronApp.close()) can hang for minutes when the app still holds a live
 * group control connection — fixture teardown then exceeds the worker
 * teardown budget (180s). Tests therefore shut their agents down explicitly:
 * graceful close gets 20s, then the process tree is force-killed. Because
 * close() is idempotent, the later fixture-teardown call returns instantly.
 */
export async function shutdownAgent(
	agent: AgentController,
	reason: string,
	graceMs = 20_000,
): Promise<void> {
	try {
		const pid = agent.pid();
		const closedGracefully = await Promise.race([
			agent.close(reason).then(() => true),
			sleep(graceMs).then(() => false),
		]);
		if (!closedGracefully && pid !== null && isPidAlive(pid)) {
			killTree(pid);
			await waitForProcessGone({ pid }, 10_000);
		}
	} catch {
		/* best effort — never fail the test in shutdown */
	}
}

/**
 * Bounded graceful close used by restart scenarios.
 *
 * OBSERVED PRODUCT BEHAVIOR (defect suspect, documented not fixed):
 * AgentController.close() → electronApp.close() does NOT complete within
 * tens of seconds while the app holds a live group control connection
 * (fixture teardown hung >180s in early runs). Returns the ExitRecord when
 * the graceful path completed within `graceMs`, otherwise null after
 * force-killing the process tree. Callers should record the outcome as an
 * artifact and treat null as a graceful-close hang (defect suspect), not a
 * test-mechanics failure.
 */
export async function closeGracefullyBounded(
	agent: AgentController,
	reason: string,
	graceMs = 75_000,
): Promise<{ exit: Awaited<ReturnType<AgentController['close']>> | null; hung: boolean }> {
	const pid = agent.pid();
	const exit = await Promise.race([
		agent.close(reason).catch(() => null),
		sleep(graceMs).then(() => '__hung__' as const),
	]);
	if (exit === '__hung__') {
		if (pid !== null && isPidAlive(pid)) {
			killTree(pid);
			await waitForProcessGone({ pid }, 15_000);
		}
		return { exit: null, hung: true };
	}
	return { exit, hung: false };
}

/** Collected pageerror events for an agent (empty array = healthy renderer). */
export function pageErrorsOf(agent: AgentController) {
	return agent.dumpLogs().pageErrors;
}

/** Cheap interactivity probe: renderer evaluates and body has content. */
export async function assertInteractive(agent: AgentController): Promise<void> {
	const text = await agent.page.locator('body').innerText({ timeout: 10_000 });
	if (text.trim().length === 0) {
		throw new Error(`agent "${agent.name}": renderer body is empty (not interactive)`);
	}
}

/** Read <userData>/groups.json (structure-tolerant) and return the parsed array. */
export function readGroupsJson(
	userDataPath: string,
): Array<Record<string, unknown>> {
	const file = path.join(userDataPath, 'groups.json');
	const raw = fs.readFileSync(file, 'utf-8');
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) {
		throw new Error(`${file}: expected a top-level array, got ${typeof parsed}`);
	}
	return parsed as Array<Record<string, unknown>>;
}

/** Extract the member-count of a persisted group record (shape-tolerant). */
export function memberCountOfRecord(record: Record<string, unknown>): number {
	const shared = record.sharedState as Record<string, unknown> | undefined;
	const members = shared?.members as Record<string, unknown> | undefined;
	return members ? Object.keys(members).length : -1;
}

export { waitFor, sleep };
export type { Page };
