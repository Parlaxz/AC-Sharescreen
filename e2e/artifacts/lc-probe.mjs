// Minimal probe: launch app, call app.quit(), measure real exit latency.
import { _electron } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = 'C:/Users/parla/OneDrive/Desktop/Development/AC-Sharescreen';
const exe = path.join(REPO, 'apps/desktop/node_modules/electron/dist/electron.exe');
const mainJs = path.join(REPO, 'apps/desktop/dist/main/main.js');

const t0 = Date.now();
const app = await _electron.launch({
	executablePath: exe,
	args: ['--dev-profile=lc-probe', '--multi-instance', mainJs],
	cwd: path.join(REPO, 'apps/desktop'),
	env: { ...process.env, SCREENLINK_E2E: '1', NODE_ENV: 'production' },
	timeout: 60_000,
});
console.log(`launch ok in ${Date.now() - t0}ms`);
await app.firstWindow({ timeout: 60_000 });
const pid = app.process().pid;
console.log('pid', pid);

await app.evaluate(({ app }) => {
	app.quit();
});
console.log(`app.quit() issued at +${Date.now() - t0}ms`);

for (let i = 0; i < 240; i++) {
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}
	if (!alive) {
		console.log(`process gone at +${Date.now() - t0}ms`);
		process.exit(0);
	}
	await new Promise((r) => setTimeout(r, 500));
}
console.log(`STILL ALIVE after +${Date.now() - t0}ms`);
