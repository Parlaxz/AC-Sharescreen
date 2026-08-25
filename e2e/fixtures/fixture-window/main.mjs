/**
 * E2E fixture window — a deterministic standalone Electron app used as a
 * capturable media source. Launched with the SAME electron.exe as ScreenLink:
 *
 *   electron.exe e2e/fixtures/fixture-window/main.mjs \
 *     --title=E2E-FIXTURE:ALICE --control-port=9770 [--audio] [--x=100 --y=100]
 *
 * - Window title is EXACTLY the --title value (capture enumeration keys on it).
 * - Full-window canvas: SMPTE-like color bars + huge frame counter +
 *   HH:MM:SS.mmm timestamp + agent label, repainted via requestAnimationFrame.
 * - Optional WebAudio square-wave oscillator alternating 440/880 Hz (1s each),
 *   gain 0.15, started on load.
 * - Control HTTP server bound to 127.0.0.1 only:
 *     GET  /frame    -> {frame, t, title}
 *     POST /minimize /restore /close
 *     POST /move?x=100&y=100
 * - userData points at a unique temp dir so it never touches app profiles.
 */
import { app, BrowserWindow } from 'electron';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const argValue = (name, def) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit !== undefined ? hit.slice(name.length + 3) : def;
};
const hasFlag = (name) => argv.includes(`--${name}`);

const TITLE = argValue('title', 'E2E-FIXTURE');
const CONTROL_PORT = Number(argValue('control-port', '9770'));
const POS_X = Number(argValue('x', '100'));
const POS_Y = Number(argValue('y', '100'));
const WITH_AUDIO = hasFlag('audio');

// Isolate userData so the fixture never collides with real app profiles.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'screenlink-fixture-')));

// Agent label parsed from title (e.g. "E2E-FIXTURE:ALICE" -> "ALICE").
const AGENT_LABEL = TITLE.includes(':') ? TITLE.split(':').slice(1).join(':') : TITLE;

const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #111; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
(() => {
  const LABEL = ${JSON.stringify(AGENT_LABEL)};
  const BAR_COLORS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let frame = 0;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }
  function timestamp(d) {
    return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '.' + pad(d.getUTCMilliseconds(), 3);
  }

  function draw() {
    frame++;
    const w = canvas.width, h = canvas.height;
    const barH = Math.floor(h * 0.72);
    const barW = w / BAR_COLORS.length;
    for (let i = 0; i < BAR_COLORS.length; i++) {
      ctx.fillStyle = BAR_COLORS[i];
      ctx.fillRect(Math.floor(i * barW), 0, Math.ceil(barW), barH);
    }
    // bottom strip
    ctx.fillStyle = '#000';
    ctx.fillRect(0, barH, w, h - barH);

    // huge monospace frame counter
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const counterSize = Math.max(28, Math.floor(h * 0.14));
    ctx.font = 'bold ' + counterSize + 'px monospace';
    ctx.fillText(String(frame), w / 2, barH + (h - barH) * 0.35);

    // timestamp
    ctx.font = Math.max(14, Math.floor(h * 0.05)) + 'px monospace';
    ctx.fillStyle = '#0f0';
    ctx.fillText(timestamp(new Date()), w / 2, barH + (h - barH) * 0.68);

    // agent label
    ctx.font = 'bold ' + Math.max(12, Math.floor(h * 0.04)) + 'px monospace';
    ctx.fillStyle = '#ff0';
    ctx.fillText(LABEL, w / 2, barH + (h - barH) * 0.9);

    window.__fixtureFrame = frame;
    window.__fixtureT = Date.now();
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  ${
    WITH_AUDIO
      ? `
  // Alternating 440/880 Hz square wave, gain 0.15, started on load.
  try {
    const actx = new AudioContext();
    const osc = actx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 440;
    const gain = actx.createGain();
    gain.gain.value = 0.15;
    osc.connect(gain).connect(actx.destination);
    osc.start();
    setInterval(() => {
      osc.frequency.value = osc.frequency.value === 440 ? 880 : 440;
    }, 1000);
  } catch (e) { console.error('audio failed', e); }
  `
      : ''
  }
})();
</script>
</body>
</html>`;

let win = null;

function createWindow() {
	win = new BrowserWindow({
		width: 800,
		height: 600,
		x: Number.isFinite(POS_X) ? POS_X : undefined,
		y: Number.isFinite(POS_Y) ? POS_Y : undefined,
		title: TITLE,
		alwaysOnTop: false,
		backgroundColor: '#111111',
		show: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
		},
	});
	// Some platforms re-title from the page <title>; keep ours authoritative.
	win.on('page-title-updated', (e) => e.preventDefault());
	win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_HTML));
}

// The control server answers /frame by querying the renderer's live counter
// asynchronously (window.__fixtureFrame, maintained by the rAF loop).
async function framePayload() {
	let frame = 0;
	if (win && !win.isDestroyed()) {
		try {
			frame = await win.webContents.executeJavaScript('window.__fixtureFrame ?? 0');
		} catch { /* renderer busy */ }
	}
	return { frame, t: Date.now(), title: TITLE };
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	res.setHeader('Content-Type', 'application/json');
	const done = (code, obj) => {
		res.statusCode = code;
		res.end(JSON.stringify(obj));
	};
	if (req.method === 'GET' && url.pathname === '/frame') {
		framePayload()
			.then((p) => done(200, p))
			.catch((e) => done(500, { error: String(e) }));
		return;
	}
	if (req.method === 'POST') {
		switch (url.pathname) {
			case '/minimize':
				if (win && !win.isDestroyed()) win.minimize();
				return done(200, { ok: true });
			case '/restore':
				if (win && !win.isDestroyed()) { win.restore(); win.show(); }
				return done(200, { ok: true });
			case '/move': {
				const x = Number(url.searchParams.get('x'));
				const y = Number(url.searchParams.get('y'));
				if (win && !win.isDestroyed() && Number.isFinite(x) && Number.isFinite(y)) {
					win.setPosition(x, y);
				}
				return done(200, { ok: true });
			}
			case '/close':
				done(200, { ok: true });
				// Give the response a moment to flush, then exit hard.
				setTimeout(() => {
					try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
					app.quit();
					setTimeout(() => process.exit(0), 500);
				}, 50);
				return;
			default:
				return done(404, { error: 'not found' });
		}
	}
	done(404, { error: 'not found' });
});

app.whenReady().then(() => {
	createWindow();
	server.listen(CONTROL_PORT, '127.0.0.1', () => {
		console.log(`[fixture] control server on 127.0.0.1:${CONTROL_PORT} title="${TITLE}"`);
	});
});

app.on('window-all-closed', () => app.quit());
