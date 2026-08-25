/**
 * helpers-lc — lane-local helpers for lifecycle.spec.ts (Phase 1).
 *
 * Everything here is additive: if a capability is missing from
 * e2e/framework/*, it lives here instead of editing shared framework code.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentController, ExitRecord } from '../framework/agent.js';
import { killTree, waitForProcessGone } from '../framework/processes.js';

// ---------------------------------------------------------------------------
// Main-process E2E marker file (<userData>/logs/e2e-markers.log)
// ---------------------------------------------------------------------------

export interface MainMarkerEntry {
	timestamp?: string;
	e2eMarker: string;
	[key: string]: unknown;
}

/** Resolve the marker file path the way apps/desktop/src/main/test-markers.ts does. */
export function markerFilePath(userDataPath: string): string {
	return path.join(userDataPath, 'logs', 'e2e-markers.log');
}

/** Read + parse the main-process marker file. Missing file → []. */
export function readMainMarkers(userDataPath: string): MainMarkerEntry[] {
	const file = markerFilePath(userDataPath);
	if (!fs.existsSync(file)) return [];
	const out: MainMarkerEntry[] = [];
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as MainMarkerEntry;
			if (typeof parsed.e2eMarker === 'string') out.push(parsed);
		} catch {
			// tolerate torn/partial trailing lines
		}
	}
	return out;
}

/** Count marker entries with the given name. */
export function countMarker(entries: MainMarkerEntry[], name: string): number {
	return entries.filter((e) => e.e2eMarker === name).length;
}

// ---------------------------------------------------------------------------
// Main-window state probe (BrowserWindow via mainEval)
// ---------------------------------------------------------------------------

export interface MainWindowState {
	windowCount: number;
	destroyed: boolean;
	visible: boolean;
	minimized: boolean;
}

/**
 * Snapshot the first BrowserWindow's state through the real Electron main
 * process. Mirrors what the tray/window-manager code sees.
 */
export async function getMainWindowState(agent: AgentController): Promise<MainWindowState> {
	return agent.mainEval(({ BrowserWindow }) => {
		const wins = BrowserWindow.getAllWindows();
		const win = wins[0];
		if (!win) {
			return { windowCount: wins.length, destroyed: true, visible: false, minimized: false };
		}
		return {
			windowCount: wins.length,
			destroyed: win.isDestroyed(),
			visible: win.isVisible(),
			minimized: win.isMinimized(),
		};
	});
}

/**
 * Restore/show/focus the main window exactly like the tray "Open ScreenLink"
 * path (WindowManager.showRestoreOrFocus → restore+show+focus).
 */
export async function mainWindowRestoreOrFocus(agent: AgentController): Promise<void> {
	await agent.mainEval(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		if (!win || win.isDestroyed()) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
	});
}

// ---------------------------------------------------------------------------
// Log-collection conveniences
// ---------------------------------------------------------------------------

/** Collected pageerror events for an agent (empty array = healthy renderer). */
export function pageErrorsOf(agent: AgentController) {
	return agent.dumpLogs().pageErrors;
}

/** Console lines matching a regex, tagged by source. */
export function consoleLinesMatching(
	agent: AgentController,
	pattern: RegExp,
): Array<{ source: string; text: string }> {
	const dump = agent.dumpLogs();
	const hits: Array<{ source: string; text: string }> = [];
	for (const entry of [...dump.rendererConsole, ...dump.mainConsole]) {
		if (pattern.test(entry.text)) hits.push({ source: entry.source, text: entry.text });
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Bounded agent shutdown
// ---------------------------------------------------------------------------

/**
 * Close an agent with a HARD bound on how long we wait for graceful exit.
 *
 * Why this exists: a known product defect (see lifecycle.spec.ts LIF-004)
 * leaves the Electron main process alive after the graceful quit pipeline
 * completes, so `AgentController.close()` (which awaits electronApp.close())
 * can hang indefinitely. This helper arms a taskkill fallback timer; if
 * graceful close has not returned within `graceMs`, the process tree is
 * force-killed, which unblocks close() and lets it record an accurate
 * ExitRecord. AgentController.close() is idempotent, so fixture teardown
 * remains safe afterwards.
 */
export async function shutdownAgent(
	agent: AgentController,
	reason: string,
	graceMs = 20_000,
): Promise<ExitRecord> {
	const pid = agent.pid();
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
	} finally {
		if (timer) clearTimeout(timer);
		if (forced && pid !== null) {
			// Ensure the tree is fully gone before returning.
			await waitForProcessGone({ pid }, 10_000);
		}
	}
}
