/**
 * AgentController — drives one real ScreenLink app instance ("agent") via
 * Playwright's Electron support.
 *
 * Launch contract (verified working on this repo):
 *   electron.exe --dev-profile=<name> --multi-instance <abs path to dist/main/main.js>
 * with cwd=apps/desktop and NODE_ENV=production.
 *
 * `--dev-profile=<name>` isolates userData into `<userDataBase>-<name>`, so
 * every agent gets its own profile directory with zero extra setup.
 * `--multi-instance` bypasses the single-instance lock for dev builds so
 * several agents can run side by side. We never pass a fixed CDP port —
 * Playwright injects its own `--remote-debugging-port=0`.
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ARTIFACTS_ROOT,
	appendJsonl,
	flushAgentLogs,
	savePng,
	writeJson,
	type AgentLogEntry,
} from './artifacts.js';
import { listProcesses, killTree, isPidAlive } from './processes.js';
import { waitFor } from './wait.js';

export const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
);
export const APPS_DESKTOP = path.join(REPO_ROOT, 'apps', 'desktop');
export const ELECTRON_EXE = path.join(
	APPS_DESKTOP,
	'node_modules',
	'electron',
	'dist',
	'electron.exe',
);
export const MAIN_JS = path.join(APPS_DESKTOP, 'dist', 'main', 'main.js');

export interface LaunchOptions {
	/** Extra env vars merged over process.env (SCREENLINK_E2E etc. are always set). */
	env?: Record<string, string>;
	/** Override the built main.js path (e.g. packaged builds later). */
	mainJs?: string;
	/** Override the electron executable (e.g. packaged builds later). */
	executablePath?: string;
	/** Launch timeout in ms. Default 60_000. */
	timeoutMs?: number;
	/** Extra CLI args appended after the standard flags (e.g. screenlink:// deep-link URLs). */
	extraArgs?: string[];
}

export interface AgentDumpedLogs {
	rendererConsole: AgentLogEntry[];
	mainConsole: AgentLogEntry[];
	pageErrors: AgentLogEntry[];
	requestFailed: AgentLogEntry[];
}

export interface ExitRecord {
	reason: string;
	gracefulClose: boolean;
	taskkillUsed: boolean;
	pid: number | null;
	closedAt: string;
}

const HELPER_PROCESS_NAMES = [
	'electron',
	'screenlink-audio-helper',
	'screenlink-video-enhancer',
];

/** Extract `{ e2eMarker: "..." }`-style payloads from console lines. */
function parseMarkerFromConsoleText(text: string): string | null {
	const match = text.match(/e2eMarker"?\]?\s*[:=]\s*"([^"]+)"/);
	return match ? match[1] : null;
}

export class AgentController {
	readonly name: string;
	readonly app: ElectronApplication;
	readonly launchedAt = new Date().toISOString();

	private attachedPages = new Set<Page>();
	private rendererConsole: AgentLogEntry[] = [];
	private mainConsole: AgentLogEntry[] = [];
	private pageErrors: AgentLogEntry[] = [];
	private requestFailed: AgentLogEntry[] = [];
	private consoleMarkers: Array<{ t: number; marker: string }> = [];

	private _page: Page | null = null;
	private exitRecord: ExitRecord | null = null;
	private closed = false;

	/** Directory where screenshots/process snapshots land (settable per test). */
	public artifactDir: string = ARTIFACTS_ROOT;

	/** Static registry of all live agents (for global cleanup). */
	private static registry = new Map<string, AgentController>();

	private constructor(name: string, app: ElectronApplication) {
		this.name = name;
		this.app = app;
	}

	static create(name: string, app: ElectronApplication): AgentController {
		const controller = new AgentController(name, app);
		controller.attachCollectors();
		AgentController.registry.set(name, controller);
		return controller;
	}

	static live(): AgentController[] {
		return [...AgentController.registry.values()];
	}

	/** Close every live agent; used by fixtures/global cleanup. */
	static async closeAllAgents(reason = 'closeAllAgents'): Promise<void> {
		const agents = AgentController.live();
		await Promise.allSettled(agents.map((a) => a.close(reason)));
	}

	// -------------------------------------------------------------------------
	// Log collection
	// -------------------------------------------------------------------------

	private attachCollectors(): void {
		// Register BEFORE any window exists so early logs are captured.
		this.app.on('window', (page: Page) => this.attachRenderer(page));
		// Main-process console messages.
		this.app.on('console', (msg) => {
			const text = typeof msg?.text === 'function' ? msg.text() : String(msg?.text ?? '');
			this.mainConsole.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				source: 'main-console',
				text,
			});
			const marker = parseMarkerFromConsoleText(text);
			if (marker) this.consoleMarkers.push({ t: Date.now(), marker });
		});
	}

	private attachRenderer(page: Page): void {
		if (this.attachedPages.has(page)) return;
		this.attachedPages.add(page);
		page.on('console', (msg) => {
			const text = msg.text();
			this.rendererConsole.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				source: 'renderer-console',
				text,
				url: page.url(),
			});
			const marker = parseMarkerFromConsoleText(text);
			if (marker) this.consoleMarkers.push({ t: Date.now(), marker });
		});
		page.on('pageerror', (err) => {
			this.pageErrors.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				source: 'pageerror',
				text: String(err?.stack ?? err),
				url: page.url(),
			});
		});
		page.on('requestfailed', (req) => {
			this.requestFailed.push({
				t: Date.now(),
				iso: new Date().toISOString(),
				source: 'requestfailed',
				text: `${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? 'unknown'}`,
			});
		});
		page.on('close', () => this.attachedPages.delete(page));
	}

	dumpLogs(): AgentDumpedLogs {
		return {
			rendererConsole: [...this.rendererConsole],
			mainConsole: [...this.mainConsole],
			pageErrors: [...this.pageErrors],
			requestFailed: [...this.requestFailed],
		};
	}

	// -------------------------------------------------------------------------
	// Accessors
	// -------------------------------------------------------------------------

	/** First window of the app (already awaited by launchAgent). */
	get page(): Page {
		if (!this._page || this._page.isClosed()) {
			throw new Error(
				`Agent "${this.name}": page not available (closed or not yet awaited) — use await agent.waitReady()`,
			);
		}
		return this._page;
	}

	/** Await + cache the first window (60s timeout). */
	async waitReady(timeoutMs = 60_000): Promise<Page> {
		if (this._page && !this._page.isClosed()) return this._page;
		this._page = await this.app.firstWindow({ timeout: timeoutMs });
		return this._page;
	}

	/** Async variant of `page` for one-liners in specs. */
	async pageAsync(timeoutMs = 60_000): Promise<Page> {
		return this.waitReady(timeoutMs);
	}

	byTestId(tid: string) {
		return this.page.getByTestId(tid);
	}

	async clickTestId(tid: string, timeoutMs = 15_000): Promise<void> {
		await this.waitForTestId(tid, timeoutMs);
		await this.byTestId(tid).click({ timeout: timeoutMs });
	}

	async fillTestId(tid: string, value: string, timeoutMs = 15_000): Promise<void> {
		await this.waitForTestId(tid, timeoutMs);
		await this.byTestId(tid).fill(value, { timeout: timeoutMs });
	}

	/**
	 * Wait for `[data-testid=tid]`; on timeout dump page URL + first 500 chars
	 * of body innerText into the error for fast diagnosis.
	 */
	async waitForTestId(
		tid: string,
		timeoutMs = 15_000,
		opts: { state?: 'visible' | 'hidden' | 'attached' } = {},
	) {
		try {
			return await this.page.getByTestId(tid).waitFor({
				state: opts.state ?? 'visible',
				timeout: timeoutMs,
			});
		} catch (err) {
			let url = '<unavailable>';
			let snippet = '<unavailable>';
			try {
				url = this.page.url();
				snippet = (await this.page.locator('body').innerText({ timeout: 2_000 })).slice(0, 500);
			} catch { /* best effort diagnostics */ }
			throw new Error(
				[
					`waitForTestId("${tid}") timed out after ${timeoutMs}ms on agent "${this.name}"`,
					`page url: ${url}`,
					`body text (first 500 chars): ${JSON.stringify(snippet)}`,
					`underlying error: ${String(err)}`,
				].join('\n'),
			);
		}
	}

	// -------------------------------------------------------------------------
	// Test-hook bridge (all defensive — hooks may not be merged yet)
	// -------------------------------------------------------------------------

	/** Read-only renderer state via window.__screenlinkTest.snapshot(). */
	async snapshot<T = unknown>(): Promise<T | null> {
		return this.page.evaluate(() => {
			const hooks = (globalThis as unknown as Record<string, any>).__screenlinkTest;
			return typeof hooks?.snapshot === 'function' ? hooks.snapshot() : null;
		}) as Promise<T | null>;
	}

	/**
	 * Drain e2e markers: from the renderer ring buffer
	 * (window.__screenlinkTestMarkers, installed by app test-hooks) AND from
	 * console lines we captured.
	 */
	async drainMarkers(): Promise<Array<{ t: number; marker: string; from: 'ring-buffer' | 'console' }>> {
		let ring: unknown[] = [];
		try {
			ring = await this.page.evaluate(() => {
				const g = globalThis as unknown as Record<string, any>;
				const rb = g.__screenlinkTestMarkers ?? g.__screenlinkMarkers;
				if (!rb) return [];
				if (typeof rb.drain === 'function') return rb.drain();
				if (Array.isArray(rb)) return rb.splice(0, rb.length);
				return [];
			});
		} catch { /* page may be mid-navigation */ }
		const fromConsole = this.consoleMarkers;
		this.consoleMarkers = [];
		return [
			...ring.map((m) => normalizeMarker(m, 'ring-buffer')),
			...fromConsole.map((m) => ({ t: m.t, marker: m.marker, from: 'console' as const })),
		];
	}

	/** Clipboard text via main-process evaluate. */
	async clipboardText(): Promise<string> {
		return this.app.evaluate(({ clipboard }) => clipboard.readText());
	}

	/** Run an arbitrary function in the main process. */
	async mainEval<T>(fn: (electron: typeof import('electron')) => T): Promise<T> {
		return this.app.evaluate(fn) as Promise<T>;
	}

	// -------------------------------------------------------------------------
	// Artifacts
	// -------------------------------------------------------------------------

	async screenshot(name: string): Promise<string> {
		const page = this._page && !this._page.isClosed() ? this._page : await this.waitReady();
		const data = await page.screenshot({ fullPage: false });
		return savePng(path.join(this.artifactDir, `${this.name}-${name}`), data);
	}

	/** Capture electron/helper processes (PID/PPID/cmdline) as a JSON artifact. */
	async processSnapshot(label: string): Promise<string> {
		const rows = await listProcesses(HELPER_PROCESS_NAMES).catch(() => []);
		const file = path.join(this.artifactDir, `${this.name}-processes-${label}.json`);
		writeJson(file, {
			agent: this.name,
			label,
			at: new Date().toISOString(),
			selfPid: this.pid(),
			processes: rows,
		});
		return file;
	}

	// -------------------------------------------------------------------------
	// Teardown
	// -------------------------------------------------------------------------

	pid(): number | null {
		try {
			return this.app.process()?.pid ?? null;
		} catch {
			// App already disposed (process exited before close) — no PID to report.
			return null;
		}
	}

	exitInfo(): ExitRecord | null {
		return this.exitRecord;
	}

	/**
	 * Graceful close with taskkill /T /F fallback. Records an exit artifact.
	 * Idempotent.
	 */
	async close(reason = 'unspecified'): Promise<ExitRecord> {
		if (this.closed) return this.exitRecord!;
		this.closed = true;

		const pid = this.pid();
		let gracefulClose = false;
		let taskkillUsed = false;

		try {
			await this.app.close();
			gracefulClose = true;
		} catch { /* fall through to force kill */ }
		if (pid !== null && isPidAlive(pid)) {
			spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
			taskkillUsed = true;
		}

		this.exitRecord = {
			reason,
			gracefulClose,
			taskkillUsed,
			pid,
			closedAt: new Date().toISOString(),
		};

		// Always flush final logs next to other artifacts.
		try {
			flushAgentLogs(this, this.artifactDir);
			appendJsonl(path.join(ARTIFACTS_ROOT, 'agent-exits.jsonl'), {
				agent: this.name,
				...this.exitRecord,
			});
		} catch { /* never fail teardown on logging */ }

		AgentController.registry.delete(this.name);
		return this.exitRecord;
	}
}

function normalizeMarker(
	m: unknown,
	from: 'ring-buffer' | 'console',
): { t: number; marker: string; from: 'ring-buffer' | 'console' } {
	if (typeof m === 'string') return { t: Date.now(), marker: m, from };
	if (m && typeof m === 'object') {
		const obj = m as Record<string, unknown>;
		const marker =
			typeof obj.e2eMarker === 'string'
				? obj.e2eMarker
				: typeof obj.marker === 'string'
					? obj.marker
					: JSON.stringify(obj);
		return { t: typeof obj.t === 'number' ? obj.t : Date.now(), marker, from };
	}
	return { t: Date.now(), marker: String(m), from };
}

/**
 * Launch a ScreenLink agent instance. Profile/userData isolation comes free
 * via `--dev-profile=<name>` (userData becomes `<base>-<name>`).
 */
export async function launchAgent(
	name: string,
	opts: LaunchOptions = {},
): Promise<AgentController> {
	const app = await _electron.launch({
		executablePath: opts.executablePath ?? ELECTRON_EXE,
		args: [
			'--dev-profile=' + name,
			'--multi-instance',
			opts.mainJs ?? MAIN_JS,
			...(opts.extraArgs ?? []),
		],
		cwd: APPS_DESKTOP,
		env: {
			...process.env,
			SCREENLINK_E2E: '1',
			NODE_ENV: 'production',
			SCREENLINK_AGENT: name,
			...opts.env,
		},
		timeout: opts.timeoutMs ?? 60_000,
	});
	const agent = AgentController.create(name, app);
	// Await the first window now so `agent.page` is immediately usable.
	// Collectors were registered inside create() BEFORE any window existed,
	// so early console/pageerror traffic is still captured.
	await agent.waitReady(opts.timeoutMs ?? 60_000);
	return agent;
}

/** Convenience: launch + wait for first window. */
export async function launchAgentAndWait(
	name: string,
	opts: LaunchOptions & { windowTimeoutMs?: number } = {},
): Promise<AgentController> {
	const agent = await launchAgent(name, opts);
	await agent.waitReady(opts.windowTimeoutMs ?? 60_000);
	return agent;
}

// Keep `waitFor` referenced for future polling extensions inside this module.
void waitFor;
