/**
 * Windows process inspection/kill helpers built on PowerShell Get-CimInstance
 * and taskkill. Used by AgentController teardown, preflight and cleanup specs.
 */
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ProcRow {
	Name: string;
	ProcessId: number;
	ParentProcessId: number;
	CommandLine?: string;
}

function runPowerShell(script: string, timeoutMs = 20_000): string {
	const res = spawnSync(
		'powershell.exe',
		['-NoProfile', '-NonInteractive', '-Command', script],
		{ timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
	);
	if (res.error && !res.stdout) throw res.error;
	return (res.stdout ?? '').trim();
}

function parseRows(stdout: string): ProcRow[] {
	if (!stdout) return [];
	let parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) parsed = [parsed];
	return parsed as ProcRow[];
}

/** Normalize a process name to include the .exe variants Win32_Process reports. */
export function normalizeNames(names: string[]): string[] {
	const out = new Set<string>();
	for (const n of names) {
		out.add(n);
		if (!n.toLowerCase().endsWith('.exe')) out.add(`${n}.exe`);
	}
	return [...out];
}

/** List processes whose Name matches any of `names` (with or without .exe). */
export async function listProcesses(names: string[]): Promise<ProcRow[]> {
	const list = normalizeNames(names);
	const psNameList = list.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
	const script =
		`$n = @(${psNameList}); ` +
		'Get-CimInstance Win32_Process | Where-Object { $n -contains $_.Name } | ' +
		'Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
	return parseRows(runPowerShell(script));
}

/** List ALL processes (bounded columns). Use sparingly. */
export async function listAllProcesses(): Promise<ProcRow[]> {
	const script =
		'Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
	return parseRows(runPowerShell(script));
}

/** Kill a process and its whole tree. Returns true if taskkill reported success. */
export function killTree(pid: number): boolean {
	const res = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
		windowsHide: true,
		encoding: 'utf8',
	});
	return res.status === 0;
}

/** Best-effort synchronous PID liveness check (signal 0 probe). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		// EPERM means it exists but we lack permission — still alive.
		return code === 'EPERM';
	}
}

export type ProcessGoneTarget = { pid: number } | { namePattern: RegExp | string };

/**
 * Wait until a process is gone, either by pid or by name regex/glob-ish
 * substring match against all running processes.
 */
export async function waitForProcessGone(
	target: ProcessGoneTarget,
	timeoutMs = 15_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const pattern =
		'namePattern' in target
			? typeof target.namePattern === 'string'
				? new RegExp(target.namePattern)
				: target.namePattern
			: null;

	for (;;) {
		let gone = false;
		if ('pid' in target) {
			gone = !isPidAlive(target.pid);
		} else if (pattern) {
			const rows = await listAllProcesses();
			gone = !rows.some((r) => pattern.test(r.Name));
		}
		if (gone) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 250));
	}
}

export interface LeftoverOffender extends ProcRow {
	reason: string;
}

/**
 * Find leftover ScreenLink-related processes after a run:
 * - any process launched with `--dev-profile=<agentName>` for the given agents
 * - any native helper process named in `extraNames`
 * Returns offenders WITHOUT killing them (callers decide policy).
 */
export async function assertNoLeftovers(
	agentNames: string[],
	extraNames: string[] = [],
): Promise<LeftoverOffender[]> {
	const offenders: LeftoverOffender[] = [];

	const rows = await listAllProcesses();
	for (const name of agentNames) {
		const needle = `--dev-profile=${name}`;
		for (const row of rows) {
			if (row.CommandLine && row.CommandLine.includes(needle)) {
				offenders.push({ ...row, reason: `dev-profile ${name} still running` });
			}
		}
	}
	if (extraNames.length > 0) {
		const wanted = new Set(normalizeNames(extraNames).map((n) => n.toLowerCase()));
		for (const row of rows) {
			if (wanted.has(row.Name.toLowerCase())) {
				offenders.push({ ...row, reason: `helper ${row.Name} still running` });
			}
		}
	}
	return offenders;
}

/** Convenience one-shot used by preflight (warn-only leftovers check). */
export async function findHelpersByName(names: string[]): Promise<ProcRow[]> {
	try {
		return await listProcesses(names);
	} catch {
		return [];
	}
}

// execFileP is currently only used by potential future version probes; keep
// referenced so bundlers/lint do not drop the import accidentally.
void execFileP;
