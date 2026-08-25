/**
 * ScreenLink E2E preflight gate (Phase 0).
 *
 * Fast mode (default): environment/artifact checks only — no builds.
 * --full: additionally shells out to typecheck/build/native checks/tests,
 *         streaming output and stopping at the first failure.
 *
 * Writes e2e/artifacts/preflight.json; exits 1 if any fast-mode check fails.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(E2E_DIR, '..');
const ARTIFACTS_DIR = path.join(E2E_DIR, 'artifacts');
const FULL = process.argv.includes('--full');

/** @returns {{pass: boolean, detail: string}} */
async function check(name, fn) {
	const started = Date.now();
	try {
		const detail = (await fn()) || 'ok';
		return { name, pass: true, detail, durationMs: Date.now() - started };
	} catch (err) {
		return {
			name,
			pass: false,
			detail: String(err?.message ?? err),
			durationMs: Date.now() - started,
		};
	}
}

function assert(cond, message) {
	if (!cond) throw new Error(message);
	return `ok`;
}

function powershell(script, timeoutMs = 20_000) {
	return new Promise((resolve, reject) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: timeoutMs, windowsHide: true },
			(err, stdout) => (err ? reject(err) : resolve(String(stdout ?? '').trim())),
		);
	});
}

function tcpTlsConnect(host, port, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: host });
		const fail = (err) => {
			socket.destroy();
			reject(err);
		};
		socket.setTimeout(timeoutMs, () => fail(new Error(`timeout after ${timeoutMs}ms`)));
		socket.once('error', fail);
		socket.once('secureConnect', () => {
			const ok = `TLS connected to ${host}:${port} (${socket.getProtocol()})`;
			socket.destroy();
			resolve(ok);
		});
	});
}

/** Run a pnpm command; on Windows pnpm is a .cmd shim so shell is required. */
function runPnpm(args, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		execFile(
			`pnpm ${args.join(' ')}`,
			{ timeout: timeoutMs, windowsHide: true, shell: true },
			(err, stdout) => (err ? reject(err) : resolve(String(stdout ?? '').trim())),
		);
	});
}

function pnpmVersion() {
	return runPnpm(['--version']);
}

async function helperVersion(exePath) {
	// Best effort: many native helpers print usage/version on --version.
	try {
		const { stdout } = await execFileP(exePath, ['--version'], {
			timeout: 5_000,
			windowsHide: true,
		});
		const text = stdout.trim();
		if (!text) return null;
		// Output may be JSON ({ "version": "..." }) — extract if parseable.
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === 'object') {
				for (const key of ['version', 'Version', 'name']) {
					if (typeof parsed[key] === 'string') return `${key}=${parsed[key]}`;
				}
				return Object.entries(parsed)
					.slice(0, 2)
					.map(([k, v]) => `${k}=${String(v)}`)
					.join(' ');
			}
		} catch { /* not JSON */ }
		return text.split(/\r?\n/)[0];
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Fast checks
// ---------------------------------------------------------------------------

const checks = [
	check('node >= 24', async () => {
		const major = Number(process.versions.node.split('.')[0]);
		assert(major >= 24, `node ${process.versions.node} is < 24`);
		return `node ${process.versions.node}`;
	}),

	check('pnpm present', async () => {
		const v = await pnpmVersion();
		assert(v.length > 0, 'pnpm --version produced no output');
		return `pnpm ${v}`;
	}),

	check('electron.exe exists', async () => {
		const p = path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
		assert(fs.existsSync(p), `missing ${p}`);
		return p;
	}),

	check('apps/desktop/dist/main/main.js exists', async () => {
		const p = path.join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'main.js');
		if (!fs.existsSync(p)) {
			throw new Error(`missing ${p} — run \`pnpm build\` first`);
		}
		return p;
	}),

	check('native helpers exist', async () => {
		const audio = path.join(REPO_ROOT, 'native', 'audio-helper', 'build', 'Release', 'screenlink-audio-helper.exe');
		const video = path.join(REPO_ROOT, 'native', 'video-enhancer', 'build', 'Release', 'screenlink-video-enhancer.exe');
		const missing = [audio, video].filter((p) => !fs.existsSync(p));
		assert(missing.length === 0, `missing: ${missing.join(', ')}`);
		const parts = [];
		for (const p of [audio, video]) {
			const v = await helperVersion(p);
			parts.push(`${path.basename(p)}${v ? ` (${v})` : ''}`);
		}
		return parts.join(', ');
	}),

	check('VDO signaling reachable (wss.vdo.ninja:443)', async () => {
		return tcpTlsConnect('wss.vdo.ninja', 443, 5_000);
	}),

	check('at least one active display', async () => {
		const out = await powershell(
			'Add-Type -AssemblyName System.Windows.Forms; @([System.Windows.Forms.Screen]::AllScreens).Count',
		);
		const count = Number(out);
		assert(Number.isFinite(count) && count >= 1, `AllScreens length = ${out}`);
		return `${count} display(s)`;
	}),

	check('@playwright/test installed', async () => {
		const require = (await import('node:module')).createRequire(import.meta.url);
		const pkgPath = require.resolve('@playwright/test/package.json');
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		return `@playwright/test ${pkg.version} @ ${pkgPath}`;
	}),

	// Warn-only: recorded as its own entry but never fails the gate.
	check('no leftover native helpers (warn-only)', async () => {
		const script =
			"$n = @('screenlink-audio-helper.exe','screenlink-video-enhancer.exe'); " +
			'$hits = Get-CimInstance Win32_Process | Where-Object { $n -contains $_.Name }; ' +
			'if ($hits) { $hits | Select-Object Name,ProcessId | ConvertTo-Json -Compress } else { "none" }';
		const out = await powershell(script);
		if (out === 'none') return 'none running';
		console.warn(`[preflight][warn] leftover native helper processes detected: ${out}`);
		return `WARN leftover processes: ${out}`;
	}),
];

// ---------------------------------------------------------------------------
// Full-mode commands
// ---------------------------------------------------------------------------

function runStreaming(cmd, args, cwd) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(cmd, args, { cwd, shell: true, stdio: 'inherit' });
		child.on('exit', (code) => {
			if (code === 0) resolve({ durationMs: Date.now() - started });
			else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
		});
		child.on('error', reject);
	});
}

async function runFullMode(results) {
	const steps = [
		['typecheck', 'pnpm', ['typecheck']],
		['build', 'pnpm', ['build']],
		['audio-helper:check', 'pnpm', ['audio-helper:check']],
		['video-enhancer:check', 'pnpm', ['video-enhancer:check']],
		['frame-ring:check', 'pnpm', ['frame-ring:check']],
		['test:all', 'pnpm', ['test:all']],
		['audio-helper:transport-test', 'pnpm', ['audio-helper:transport-test']],
	];
	for (const [name, cmd, args] of steps) {
		const started = Date.now();
		console.log(`\n[preflight:full] >>> ${name} ($ pnpm ${args.join(' ')})`);
		try {
			await runStreaming(cmd, args, REPO_ROOT);
			results.push({
				name: `full:${name}`,
				pass: true,
				detail: 'ok',
				durationMs: Date.now() - started,
			});
		} catch (err) {
			results.push({
				name: `full:${name}`,
				pass: false,
				detail: String(err?.message ?? err),
				durationMs: Date.now() - started,
			});
			throw err; // stop on first failure
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

	const results = [];
	for (const c of checks) results.push(await c);

	if (FULL) {
		try {
			await runFullMode(results);
		} catch (err) {
			console.error(`\n[preflight:full] STOPPED on first failure: ${err.message}`);
		}
	}

	// Resolved profile-dir heuristic info for the operator.
	let desktopName = 'unknown';
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(REPO_ROOT, 'apps', 'desktop', 'package.json'), 'utf8'),
		);
		desktopName = pkg.name ?? desktopName;
	} catch { /* ignore */ }

	const failed = results.filter((r) => !r.pass);
	const report = {
		mode: FULL ? 'full' : 'fast',
		at: new Date().toISOString(),
		appPackage: desktopName,
		profileDirHeuristic: `%APPDATA%\\<appUserDataBase>-<profile> (base folder may be 'screenlink' or 'Electron'; agents append '-<name>')`,
		allPassed: failed.length === 0,
		failedCount: failed.length,
		results,
	};
	const outFile = path.join(ARTIFACTS_DIR, 'preflight.json');
	fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');

	// Human summary table.
	console.log('\n=== ScreenLink E2E Preflight (' + report.mode + ' mode) ===');
	for (const r of results) {
		const icon = r.pass ? 'PASS' : 'FAIL';
		console.log(`[${icon}] ${r.name.padEnd(50)} ${r.durationMs}ms  ${r.detail}`);
	}
	console.log('---------------------------------------------------------');
	console.log(
		failed.length === 0
			? `ALL CHECKS PASSED (${results.length})`
			: `${failed.length}/${results.length} CHECK(S) FAILED`,
	);
	console.log(`report: ${outFile}`);

	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error('[preflight] fatal:', err);
	process.exit(1);
});
