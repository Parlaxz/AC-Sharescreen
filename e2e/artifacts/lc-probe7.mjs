// Probe 7: classify the lingering sockets (Pipe vs TCP) and find owners.
import { _electron } from '@playwright/test';
import path from 'node:path';

const REPO = 'C:/Users/parla/OneDrive/Desktop/Development/AC-Sharescreen';
const exe = path.join(REPO, 'apps/desktop/node_modules/electron/dist/electron.exe');
const mainJs = path.join(REPO, 'apps/desktop/dist/main/main.js');

const app = await _electron.launch({
	executablePath: exe,
	args: ['--dev-profile=lc-probe7', '--multi-instance', mainJs],
	cwd: path.join(REPO, 'apps/desktop'),
	env: { ...process.env, SCREENLINK_E2E: '1', NODE_ENV: 'production' },
	timeout: 60_000,
});
await app.firstWindow({ timeout: 60_000 });
const pid = app.process().pid;

const alive = () => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Baseline BEFORE quit: what handles exist while running normally?
const before = await app.evaluate(() => {
	return (process._getActiveHandles?.() ?? []).map((h) => ({
		type: h.constructor?.name,
		handleType: h._handle?.constructor?.name ?? null,
		fd: h._handle?.fd ?? null,
		ipc: h._handle?.ipc ?? null,
		localPort: h.localPort ?? null,
		remotePort: h.remotePort ?? null,
	}));
});
console.log('BEFORE QUIT:', JSON.stringify(before));

await app.evaluate(({ app }) => {
	app.quit();
});
await new Promise((r) => setTimeout(r, 8000));
console.log('alive after 8s:', alive());

if (alive()) {
	const after = await Promise.race([
		app.evaluate(() => {
			return (process._getActiveHandles?.() ?? []).map((h) => ({
				type: h.constructor?.name,
				handleType: h._handle?.constructor?.name ?? null,
				fd: h._handle?.fd ?? null,
				ipc: h._handle?.ipc ?? null,
				localPort: h.localPort ?? null,
				remotePort: h.remotePort ?? null,
				bytesRead: h.bytesRead ?? null,
				bytesWritten: h.bytesWritten ?? null,
			}));
		}),
		new Promise((r) => setTimeout(() => r('EVAL-TIMEOUT'), 5000)),
	]);
	console.log('AFTER QUIT:', JSON.stringify(after));
}
process.exit(0);
