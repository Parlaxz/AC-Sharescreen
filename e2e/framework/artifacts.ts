/**
 * Artifact persistence for the E2E suite.
 * Everything lands under e2e/artifacts (JSON/JSONL/PNG/logs/env manifest).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);

export const E2E_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
export const ARTIFACTS_ROOT = path.join(E2E_ROOT, 'artifacts');

export function ensureDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function nowStamp(): string {
	return new Date().toISOString();
}

/** Append one JSON object as a line to a .jsonl file. */
export function appendJsonl(file: string, obj: unknown): void {
	ensureDir(path.dirname(file));
	fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/** Write a pretty-printed JSON file. */
export function writeJson(file: string, obj: unknown): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Save PNG bytes; returns the written path. */
export function savePng(file: string, data: Buffer): string {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, data);
	return file;
}

export interface AgentLogEntry {
	t: number;
	iso: string;
	source: 'renderer-console' | 'main-console' | 'pageerror' | 'requestfailed';
	text: string;
	url?: string;
}

interface LogFlushable {
	name: string;
	dumpLogs(): {
		rendererConsole: AgentLogEntry[];
		mainConsole: AgentLogEntry[];
		pageErrors: AgentLogEntry[];
		requestFailed: AgentLogEntry[];
	};
}

/** Dump all log buffers of an agent into <dir>/<agent>-logs.json. */
export function flushAgentLogs(agent: LogFlushable, dir: string = ARTIFACTS_ROOT): string {
	const file = path.join(ensureDir(dir), `${agent.name}-logs.json`);
	writeJson(file, {
		agent: agent.name,
		flushedAt: nowStamp(),
		...agent.dumpLogs(),
	});
	return file;
}

/**
 * Per-test artifact writer bound to a directory
 * (e2e/artifacts/<testfile>-<testtitle-slug>/).
 */
export class ArtifactWriter {
	public readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	ensure(): this {
		ensureDir(this.dir);
		return this;
	}

	appendJsonl(name: string, obj: unknown): string {
		const file = path.join(this.ensure().dir, name);
		appendJsonl(file, obj);
		return file;
	}

	writeJson(name: string, obj: unknown): string {
		const file = path.join(this.ensure().dir, name);
		writeJson(file, obj);
		return file;
	}

	savePng(name: string, data: Buffer): string {
		const file = path.join(this.ensure().dir, name.endsWith('.png') ? name : `${name}.png`);
		savePng(file, data);
		return file;
	}

	flushAgentLogs(agent: LogFlushable): string {
		return flushAgentLogs(agent, this.ensure().dir);
	}
}

// ---------------------------------------------------------------------------
// Environment manifest (written once per run)
// ---------------------------------------------------------------------------

async function powershellJson(script: string): Promise<unknown> {
	try {
		const { stdout } = await execFileP(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 20_000, windowsHide: true },
		);
		const trimmed = stdout.trim();
		if (!trimmed) return null;
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

let envManifestPromise: Promise<string> | null = null;

/**
 * Write e2e/artifacts/env.json once per run (guarded against duplicates).
 * Contains OS, node/pnpm versions, app version, git SHA, GPU info, displays.
 */
export function writeEnvManifest(): Promise<string> {
	if (!envManifestPromise) {
		envManifestPromise = doWriteEnvManifest().catch((err) => {
			envManifestPromise = null; // allow retry on next call
			throw err;
		});
	}
	return envManifestPromise;
}

async function doWriteEnvManifest(): Promise<string> {
	const file = path.join(ensureDir(ARTIFACTS_ROOT), 'env.json');
	if (fs.existsSync(file)) return file;

	const [osInfo, gpu, monitors] = await Promise.all([
		powershellJson(
			'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,BuildNumber,Version | ConvertTo-Json -Compress',
		),
		powershellJson(
			'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress',
		),
		powershellJson(
			'$m = Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicSourceParams -ErrorAction SilentlyContinue; ' +
				'if ($m) { @{ source = "wmi"; active = @($m).Count } | ConvertTo-Json -Compress } ' +
				'else { Add-Type -AssemblyName System.Windows.Forms; ' +
				'@{ source = "forms"; screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.DeviceName + "|" + $_.Bounds.ToString() }) } | ConvertTo-Json -Compress }',
		),
	]);

	let pnpmVersion: string | null = null;
	let gitSha: string | null = null;
	let appVersion: string | null = null;
	try {
		pnpmVersion = (await execFileP('pnpm', ['--version'], { timeout: 15_000 })).stdout.trim();
	} catch { /* ignore */ }
	try {
		gitSha = (await execFileP('git', ['rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim();
	} catch { /* ignore */ }
	try {
		const desktopPkg = JSON.parse(
			fs.readFileSync(
				path.resolve(E2E_ROOT, '..', 'apps', 'desktop', 'package.json'),
				'utf8',
			),
		) as { version?: string };
		appVersion = desktopPkg.version ?? null;
	} catch { /* ignore */ }

	const manifest = {
		writtenAt: nowStamp(),
		os: osInfo,
		node: process.version,
		pnpm: pnpmVersion,
		appVersion,
		gitSha,
		gpu,
		displays: monitors,
		platform: process.platform,
	};
	writeJson(file, manifest);
	return file;
}
