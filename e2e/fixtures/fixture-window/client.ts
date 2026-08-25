/**
 * JS client for the E2E fixture window app (see ./main.mjs).
 *
 * startFixture({ agent: 'alice', controlPort?, audio?, x?, y? }) spawns
 * electron.exe with the fixture main.mjs, waits until GET /frame returns 200,
 * and returns a handle { stop(), frames(), minimize(), restore(), close(),
 * pid, title }.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ELECTRON_EXE, REPO_ROOT } from '../../framework/agent.js';
import { killTree } from '../../framework/processes.js';
import { sleep } from '../../framework/wait.js';

const FIXTURE_MAIN = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'main.mjs',
);

export interface StartFixtureOptions {
	/** Agent label; title becomes `E2E-FIXTURE:<AGENT.toUpperCase()>`. */
	agent: string;
	controlPort?: number;
	audio?: boolean;
	x?: number;
	y?: number;
}

export interface FixtureHandle {
	pid: number | null;
	title: string;
	/** Current frame count via GET /frame. */
	frames(): Promise<number>;
	minimize(): Promise<void>;
	restore(): Promise<void>;
	close(): Promise<void>;
	/** close() + taskkill fallback + wait for exit. */
	stop(): Promise<void>;
}

async function httpJson(port: number, method: 'GET' | 'POST', pathname: string): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
	if (!res.ok) throw new Error(`fixture ${method} ${pathname} -> HTTP ${res.status}`);
	return res.json();
}

export async function startFixture(opts: StartFixtureOptions): Promise<FixtureHandle> {
	const agent = opts.agent;
	const controlPort = opts.controlPort ?? 9700 + Math.floor(Math.random() * 100);
	const title = `E2E-FIXTURE:${agent.toUpperCase()}`;

	const args = [
		FIXTURE_MAIN,
		`--title=${title}`,
		`--control-port=${controlPort}`,
	];
	if (opts.audio) args.push('--audio');
	if (opts.x !== undefined) args.push(`--x=${opts.x}`);
	if (opts.y !== undefined) args.push(`--y=${opts.y}`);
	// Autoplay policy so the WebAudio oscillator can start without a gesture.
	args.push('--autoplay-policy=no-user-gesture-required');

	const child: ChildProcess = spawn(ELECTRON_EXE, args, {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	child.stdout?.on('data', () => { /* drain */ });
	child.stderr?.on('data', () => { /* drain */ });

	const pid = child.pid ?? null;

	// Wait for the control server to come up.
	const deadline = Date.now() + 20_000;
	let ready = false;
	let lastErr: unknown = null;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`fixture process exited early with code ${child.exitCode}`);
		}
		try {
			await httpJson(controlPort, 'GET', '/frame');
			ready = true;
			break;
		} catch (err) {
			lastErr = err;
			await sleep(250);
		}
	}
	if (!ready) {
		killTree(pid ?? -1);
		throw new Error(`fixture control server did not become ready on port ${controlPort}: ${String(lastErr)}`);
	}

	const post = async (pathname: string) => httpJson(controlPort, 'POST', pathname);

	async function close(): Promise<void> {
		try {
			await post('/close');
		} catch { /* server may already be down */ }
	}

	async function stop(): Promise<void> {
		await close();
		const exited = await Promise.race([
			new Promise<boolean>((resolve) => {
				if (child.exitCode !== null) return resolve(true);
				child.once('exit', () => resolve(true));
				setTimeout(() => resolve(false), 5_000);
			}),
		]);
		if (!exited && pid !== null) killTree(pid);
	}

	return {
		pid,
		title,
		async frames(): Promise<number> {
			const payload = await httpJson(controlPort, 'GET', '/frame');
			return Number(payload.frame ?? 0);
		},
		minimize: () => post('/minimize').then(() => undefined),
		restore: () => post('/restore').then(() => undefined),
		close,
		stop,
	};
}
