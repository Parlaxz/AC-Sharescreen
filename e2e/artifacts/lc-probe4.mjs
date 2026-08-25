// Probe 4: inspect active handles in the main process while it refuses to exit.
import { _electron } from '@playwright/test';
import path from 'node:path';

const REPO = 'C:/Users/parla/OneDrive/Desktop/Development/AC-Sharescreen';
const exe = path.join(REPO, 'apps/desktop/node_modules/electron/dist/electron.exe');
const mainJs = path.join(REPO, 'apps/desktop/dist/main/main.js');

const app = await _electron.launch({
	executablePath: exe,
	args: ['--dev-profile=lc-probe4', '--multi-instance', mainJs],
	cwd: path.join(REPO, 'apps/desktop'),
	env: { ...process.env, SCREENLINK_E2E: '1', NODE_ENV: 'production' },
	timeout: 60_000,
});
await app.firstWindow({ timeout: 60_000 });
const pid = app.process().pid;
console.log('pid', pid);

const alive = () => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

await app.evaluate(({ app }) => {
	app.quit();
});
console.log('app.quit() issued');
await new Promise((r) => setTimeout(r, 8000));
console.log('alive after 8s:', alive());

try {
	const info = await Promise.race([
		app.evaluate((electron) => {
			const p = electron.process;
			const handles = (p)._getActiveHandles?.() ?? [];
			const requests = (p)._getActiveRequests?.() ?? [];
			return {
				handles: handles.map((h) => {
					if (!h || typeof h !== 'object') return String(h);
					return {
						type: h.constructor?.name ?? typeof h,
						hasRef: typeof h.hasRef === 'function' ? h.hasRef() : null,
						// TCP/Server sockets
						localAddress: h.localAddress ?? null,
						remoteAddress: h.remoteAddress ?? null,
						localPort: h.localPort ?? null,
						remotePort: h.remotePort ?? null,
						listening: typeof h.listening === 'boolean' ? h.listening : null,
					};
				}),
				requestCount: requests.length,
			};
		}),
		new Promise((r) => setTimeout(() => r('EVAL-TIMEOUT'), 5000)),
	]);
	console.log(JSON.stringify(info, null, 1));
} catch (err) {
	console.log('evaluate failed:', String(err).slice(0, 300));
}

// Also check child processes of pid via PowerShell outside.
console.log('done inspection');
