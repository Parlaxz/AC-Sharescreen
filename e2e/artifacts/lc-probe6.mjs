// Probe 6: does the MINIMAL repro also hang when launched via Playwright?
// If yes -> the hang is a Playwright<->Electron interaction, not product code.
import { _electron } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';

const REPO = 'C:/Users/parla/OneDrive/Desktop/Development/AC-Sharescreen';
const exe = path.join(REPO, 'apps/desktop/node_modules/electron/dist/electron.exe');
const reproMain = path.join(os.tmpdir(), 'opencode', 'lc-repro', 'main.js');

const app = await _electron.launch({
	executablePath: exe,
	args: ['--multi-instance', reproMain],
	cwd: path.join(REPO, 'apps/desktop'),
	timeout: 60_000,
});
await app.firstWindow({ timeout: 60_000 }).catch(() => {});
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

for (let i = 0; i < 40; i++) {
	if (!alive()) {
		console.log(`process gone at +${i * 500}ms after quit`);
		process.exit(0);
	}
	await new Promise((r) => setTimeout(r, 500));
}
console.log('MINIMAL REPRO ALSO HANGS under Playwright after 20s');
process.exit(0);
