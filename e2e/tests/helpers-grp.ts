/**
 * helpers-grp — shared helpers for the group creation/management specs
 * (GRP-001..GRP-014). Lane-local: nothing here edits framework code.
 *
 * Conventions:
 * - Only testid / role / aria-label / data-* selectors.
 * - All waits are labeled polls (framework/wait.ts) — no bare sleeps except
 *   tiny settle polls explicitly commented.
 * - snapshot() access is defensive: hooks may be missing → null-shaped state.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
	AgentController,
	type ExitRecord,
} from '../framework/agent.js';
import { isPidAlive, killTree, waitForProcessGone } from '../framework/processes.js';
import { test as baseTest, expect } from '../framework/fixtures.js';
import { waitFor } from '../framework/wait.js';

// ─── Snapshot shape (defensive, mirrors renderer test-hooks.ts) ──────────────

export interface GrpSnapshot {
	currentPage: string | null;
	selectedGroupId: string | null;
	groups: Array<{ id: string; name: string; memberCount: number }>;
	groupConnections: Array<{
		groupId: string;
		state: string;
		onlinePeers: string[];
		error: string | null;
	}>;
}

export async function getSnapshot(agent: AgentController): Promise<GrpSnapshot> {
	const raw = await agent.snapshot<Record<string, unknown> | null>();
	if (!raw || typeof raw !== 'object') {
		return {
			currentPage: null,
			selectedGroupId: null,
			groups: [],
			groupConnections: [],
		};
	}
	return {
		currentPage: typeof raw.currentPage === 'string' ? raw.currentPage : null,
		selectedGroupId: typeof raw.selectedGroupId === 'string' ? raw.selectedGroupId : null,
		groups: Array.isArray(raw.groups)
			? (raw.groups as GrpSnapshot['groups'])
			: [],
		groupConnections: Array.isArray(raw.groupConnections)
			? (raw.groupConnections as GrpSnapshot['groupConnections'])
			: [],
	};
}

/** Poll snapshot() until `pred` returns a truthy value; resolve with it. */
export function snapshotUntil<T>(
	agent: AgentController,
	pred: (s: GrpSnapshot) => T | null | undefined | false,
	timeoutMs: number,
	label: string,
): Promise<T> {
	return waitFor(async () => pred(await getSnapshot(agent)) || null, {
		timeout: timeoutMs,
		interval: 500,
		label,
	});
}

// ─── Run-scoped naming ───────────────────────────────────────────────────────

let counter = 0;

/** Unique per-call suffix so profiles/groups never collide across runs. */
export function uniqueSuffix(): string {
	counter += 1;
	return `${Date.now().toString(36)}${counter}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// ─── Generic UI helpers ──────────────────────────────────────────────────────

export async function expectNoPageErrors(agent: AgentController): Promise<void> {
	const errs = agent.dumpLogs().pageErrors;
	if (errs.length > 0) {
		throw new Error(
			`agent "${agent.name}" recorded ${errs.length} pageerror(s):\n` +
				errs.map((e) => e.text.slice(0, 400)).join('\n---\n'),
		);
	}
}

/** Clear the OS clipboard so stale links can't leak between assertions. */
export async function clearClipboard(agent: AgentController): Promise<void> {
	await agent.mainEval(({ clipboard }) => clipboard.writeText(''));
}

/**
 * Open the shared CreateGroupDialog. Multiple buttons share the accessible
 * name "Create group" (HomePage actions, dashboard empty-state, rail menu);
 * they all set the same store flag, so clicking the first visible one is fine.
 */
export async function openCreateDialog(page: Page): Promise<void> {
	await page
		.getByRole('button', { name: 'Create group', exact: true })
		.first()
		.click({ timeout: 15_000 });
	await page.getByTestId('create-group-dialog').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Create a group through the shared dialog. Returns once the dialog has
 * closed and the app auto-navigated to the new group's overview.
 */
export async function createGroupViaUi(
	agent: AgentController,
	name: string,
): Promise<string> {
	await openCreateDialog(agent.page);
	await agent.fillTestId('create-group-name-input', name);
	await agent.clickTestId('create-group-submit');
	await agent.page
		.getByTestId('create-group-dialog')
		.waitFor({ state: 'hidden', timeout: 20_000 });
	// createGroupAction selects the new group and navigates to its overview.
	await agent.page
		.getByTestId('group-overview-root')
		.waitFor({ state: 'visible', timeout: 20_000 });
	const groupId = await snapshotUntil(
		agent,
		(s) => s.groups.find((g) => g.name === name)?.id ?? null,
		10_000,
		`created group "${name}" present in snapshot`,
	);
	return groupId;
}

/** Open the second group via the rail "+" dropdown, then create it. */
export async function createSecondGroupViaRail(
	agent: AgentController,
	name: string,
): Promise<string> {
	await agent.page.locator('[aria-label="Create or join group"]').click();
	await agent.page
		.getByRole('menuitem', { name: 'Create group', exact: true })
		.click({ timeout: 10_000 });
	await agent.fillTestId('create-group-name-input', name);
	await agent.clickTestId('create-group-submit');
	await agent.page
		.getByTestId('create-group-dialog')
		.waitFor({ state: 'hidden', timeout: 20_000 });
	await agent.page
		.getByTestId('group-overview-root')
		.waitFor({ state: 'visible', timeout: 20_000 });
	return snapshotUntil(
		agent,
		(s) => s.groups.find((g) => g.name === name)?.id ?? null,
		10_000,
		`created group "${name}" present in snapshot`,
	);
}

export async function openJoinDialog(page: Page): Promise<void> {
	await page
		.getByRole('button', { name: 'Join group', exact: true })
		.first()
		.click({ timeout: 15_000 });
	await page.getByTestId('join-group-dialog').waitFor({ state: 'visible', timeout: 10_000 });
}

/**
 * Join a group via the shared dialog with an invite link. Real signaling
 * joins take seconds-to-a-minute, hence the generous close timeout.
 */
export async function joinGroupViaUi(agent: AgentController, link: string): Promise<void> {
	await openJoinDialog(agent.page);
	await agent.fillTestId('join-invite-input', link);
	await agent.clickTestId('join-group-submit');
	await agent.page
		.getByTestId('join-group-dialog')
		.waitFor({ state: 'hidden', timeout: 90_000 });
}

/** Select a group via the left rail icon button (aria-label "Group: <name>"). */
export async function selectGroupViaRail(page: Page, groupName: string): Promise<void> {
	await page.locator(`[aria-label="Group: ${groupName}"]`).click({ timeout: 15_000 });
	await page.getByTestId('group-overview-root').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Navigate to the Group settings page for the currently selected group. */
export async function openGroupSettings(page: Page): Promise<void> {
	await page
		.getByRole('button', { name: 'Group settings', exact: true })
		.first()
		.click({ timeout: 15_000 });
	await page.getByTestId('group-settings-root').waitFor({ state: 'visible', timeout: 15_000 });
}

export async function gotoHome(agent: AgentController): Promise<void> {
	await agent.byTestId('nav-home').click();
	await waitFor(
		async () => ((await getSnapshot(agent)).currentPage === 'home' ? true : null),
		{ timeout: 10_000, interval: 250, label: 'navigate home' },
	);
}

/** Read this agent's own display name from the user-settings page. */
export async function getOwnDisplayName(agent: AgentController): Promise<string> {
	await agent.byTestId('nav-settings').click();
	const input = agent.byTestId('settings-display-name-input');
	await input.waitFor({ state: 'visible', timeout: 15_000 });
	const name = ((await input.inputValue()) || '').trim();
	await agent.byTestId('nav-home').click();
	if (!name) throw new Error(`agent "${agent.name}": display name is empty`);
	return name;
}

/**
 * Set the local display name through the REAL Settings UI (same LIF-005
 * path the mesh lane uses). Needed because arbitrary --dev-profile suffixes
 * default to the display name "Host", which collides across agents.
 */
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

// ─── Members ─────────────────────────────────────────────────────────────────

/** Wait until the visible members-list has exactly `count` rows. */
export function waitForMemberRowCount(
	agent: AgentController,
	count: number,
	timeoutMs = 60_000,
): Promise<number> {
	return waitFor(async () => {
		const n = await agent.page.getByTestId('member-row').count();
		return n === count ? n : null;
	}, { timeout: timeoutMs, interval: 1_000, label: `member-row count == ${count}` });
}

export async function memberRowNames(agent: AgentController): Promise<string[]> {
	return agent.page.getByTestId('member-row').evaluateAll((els) =>
		els.map((e) => e.getAttribute('data-member-name') ?? ''),
	);
}

// ─── Markers ─────────────────────────────────────────────────────────────────

/**
 * Wait until `marker` appears.
 *
 * OBSERVED FRAMEWORK GAP (same as helpers-mesh.ts): AgentController.drainMarkers()
 * reads window.__screenlinkMarkers, but test-hooks.ts installs the ring buffer
 * as window.__screenlinkTestMarkers (with all()/last(), no drain()) — so the
 * ring-buffer half of drainMarkers() always returns [] and console capture is
 * empty in this environment. The ring buffer IS readable directly, so we poll
 * __screenlinkTestMarkers.all() here and fall back to drainMarkers() for
 * whatever console capture manages to see.
 */
export function drainUntilMarker(
	agent: AgentController,
	marker: string,
	timeoutMs = 60_000,
): Promise<true> {
	const seen = new Set<string>();
	return waitFor(async () => {
		try {
			const ring = await agent.page.evaluate(() => {
				const rb = (
					globalThis as unknown as Record<string, any>
				).__screenlinkTestMarkers;
				return rb && typeof rb.all === 'function' ? rb.all() : [];
			});
			for (const m of ring as Array<{ e2eMarker?: string }>) {
				if (typeof m?.e2eMarker === 'string') seen.add(m.e2eMarker);
			}
		} catch {
			/* page may be mid-navigation */
		}
		for (const m of await agent.drainMarkers()) seen.add(m.marker);
		return seen.has(marker) ? (true as const) : null;
	}, { timeout: timeoutMs, interval: 500, label: `e2e marker "${marker}"` }) as Promise<true>;
}

// ─── Invite link plumbing ────────────────────────────────────────────────────

/**
 * Copy the current group's invite using the overview "Invite" button
 * (direct clipboard copy — see GroupOverview.handleInvite) and return the
 * clipboard content once it holds a screenlink:// invite.
 */
export async function copyInviteFromOverview(agent: AgentController): Promise<string> {
	await clearClipboard(agent);
	await agent.clickTestId('invite-button');
	let link = '';
	await waitFor(async () => {
		link = (await agent.clipboardText()).trim();
		return link.startsWith('screenlink://') ? link : null;
	}, { timeout: 15_000, interval: 300, label: 'invite link lands in clipboard' });
	return link;
}

/**
 * Open the InviteDialog via the dashboard overflow menu
 * ("Group menu" → "Invite members") — the only path that renders
 * [data-testid=invite-dialog].
 */
export async function openInviteDialogViaMenu(page: Page): Promise<void> {
	await page.locator('[aria-label="Group menu"]').click({ timeout: 15_000 });
	await page
		.getByRole('menuitem', { name: 'Invite members' })
		.click({ timeout: 10_000 });
	await page.getByTestId('invite-dialog').waitFor({ state: 'visible', timeout: 15_000 });
}

// ─── Persistence (groups.json) ───────────────────────────────────────────────

export async function getUserDataDir(agent: AgentController): Promise<string> {
	return agent.mainEval((electron) => electron.app.getPath('userData'));
}

export function readGroupsJson(userDataDir: string): Array<Record<string, unknown>> {
	const file = path.join(userDataDir, 'groups.json');
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
		return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
	} catch {
		return [];
	}
}

/** Poll groups.json on disk until `pred` matches the record for `groupId`. */
export function waitGroupsJson<T>(
	userDataDir: string,
	groupId: string,
	pred: (record: Record<string, unknown>) => T | null | undefined | false,
	timeoutMs: number,
	label: string,
): Promise<T> {
	return waitFor(async () => {
		const rec = readGroupsJson(userDataDir).find((r) => r.groupId === groupId);
		return rec ? pred(rec) || null : null;
	}, { timeout: timeoutMs, interval: 500, label }) as Promise<T>;
}

// ─── Bounded shutdown (mirrors helpers-lc.shutdownAgent) ─────────────────────

/**
 * Close an agent with a HARD bound on how long we wait for graceful exit.
 *
 * Known product defect: graceful quit completes but the Electron main process
 * lingers under piped stdio, so AgentController.close() (which awaits
 * electronApp.close()) can hang indefinitely. This helper arms a taskkill
 * fallback timer; if graceful close has not returned within `graceMs`, the
 * process tree is force-killed, which unblocks close(). close() is
 * idempotent, so fixture teardown remains safe afterwards.
 */
export async function shutdownAgent(
	agent: AgentController,
	reason: string,
	graceMs = 20_000,
): Promise<ExitRecord | null> {
	// pid() can THROW when Playwright already disposed the app internals
	// (e.g. the process was force-killed earlier) — treat as "no pid".
	let pid: number | null = null;
	try {
		pid = agent.pid();
	} catch {
		pid = null;
	}
	let forced = false;
	const timer =
		pid !== null
			? setTimeout(() => {
					forced = true;
					killTree(pid as number);
				}, graceMs)
			: null;
	try {
		return await agent.close(reason);
	} catch {
		// close() itself can throw on a disposed app (AgentController.close
		// only guards app.close(), not its own bookkeeping calls). Make sure
		// the process tree is really gone, then surface whatever was recorded.
		if (pid !== null && isPidAlive(pid)) {
			forced = true;
			killTree(pid);
		}
		return agent.exitInfo();
	} finally {
		if (timer) clearTimeout(timer);
		if (pid !== null && (forced || agent.exitInfo() === null)) {
			// Ensure the tree is fully gone before returning.
			await waitForProcessGone({ pid }, 10_000).catch(() => {});
		}
	}
}

/**
 * Boundedly shut down every live agent in parallel (per-agent fallback
 * timers). No-op when the registry is empty.
 */
export async function shutdownAllLiveAgents(reason: string, graceMs = 20_000): Promise<void> {
	const agents = AgentController.live();
	if (agents.length === 0) return;
	await Promise.allSettled(agents.map((a) => shutdownAgent(a, reason, graceMs)));
}

// ─── Lane test with bounded teardown ─────────────────────────────────────────

/**
 * The shared createAgent fixture tears its agents down with UNBOUNDED
 * agent.close() calls — with the known quit-hang defect that exceeds the
 * whole test timeout (observed: "Tearing down createAgent exceeded the test
 * timeout of 180000ms"). We cannot edit framework code from this lane, so we
 * wrap the test in an auto-fixture that depends on createAgent (guaranteeing
 * it tears down BEFORE the fixture's own teardown) and boundedly kills every
 * still-live agent right after the test body finishes — on success AND on
 * failure/timeout. Afterwards the fixture's close() calls are idempotent
 * no-ops.
 */
export const test = baseTest.extend<{ __grpBoundedTeardown: void }>({
	__grpBoundedTeardown: [
		async ({ createAgent }, use) => {
			void createAgent; // dependency only: pins teardown ordering
			await use();
			await shutdownAllLiveAgents('grp-bounded-teardown');
		},
		{ auto: true },
	],
});
