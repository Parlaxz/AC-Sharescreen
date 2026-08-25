// Probe 2: after app.quit() hangs, inspect state and try app.exit().
import { _electron } from '@playwright/test';
import path from 'node:path';

const REPO = 'C:/Users/parla/OneDrive/Desktop/Development/AC-Sharescreen';
const exe = path.join(REPO, 'apps/desktop/node_modules/electron/dist/electron.exe');
const mainJs = path.join(REPO, 'apps/desktop/dist/main/main.js');

const t0 = Date.now();
const app = await _electron.launch({
	executablePath: exe,
	args: ['--dev-profile=lc-probe2', '--multi-instance', mainJs],
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
console.log(`app.quit() issued at +${Date.now() - t0}ms`);

// Give the quit pipeline its documented 3s grace, then inspect.
await new Promise((r) => setTimeout(r, 8000));
console.log(`still alive 8s after quit: ${alive()}`);

try {
	const state = await Promise.race([
		app.evaluate(({ BrowserWindow, app }) => ({
			windows: BrowserWindow.getAllWindows().length,
			quitting: app.quitting ?? null,
		})),
		new Promise((r) => setTimeout(() => r('TIMEOUT'), 5000)),
	]);
	console.log('state after quit:', JSON.stringify(state));
} catch (err) {
	console.log('evaluate failed:', String(err).slice(0, 200));
}

if (alive()) {
	console.log('issuing app.exit() (hard) ...');
	try {
		await app.evaluate(({ app }) => {
			app.exit(0);
		});
	} catch (err) {
		console.log('exit evaluate error (expected if process died):', String(err).slice(0, 120));
	}
	for (let i = 0; i < 20; i++) {
		if (!alive()) {
			console.log(`process gone after app.exit() at +${Date.now() - t0}ms`);
			process.exit(0);
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(`STILL ALIVE even after app.exit() at +${Date.now() - t0}ms`);
}
