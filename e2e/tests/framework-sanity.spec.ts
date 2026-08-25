/**
 * Framework sanity spec — validates the E2E harness end-to-end.
 *
 * Once the test-hook lane merges (SCREENLINK_E2E=1 exposing
 * window.screenlink.__e2eEnabled / __screenlinkTest.snapshot() /
 * __screenlinkMarkers), this also exercises those hooks. Until then it logs
 * 'HOOKS-NOT-MERGED' and passes on launch/UI health alone — but MUST fail if
 * launching the app or rendering its UI is broken.
 */
import { test, expect } from '../framework/fixtures.js';
import { waitForProcessGone } from '../framework/processes.js';

test('@critical @smoke framework sanity: launch agent, probe hooks, screenshot, clean close', async ({
	createAgent,
	artifactDir,
}) => {
	// Unique profile name so a stale profile can never collide with this run.
	const agent = await createAgent(`sanity-a-${process.pid}`);

	const page = agent.page;
	await page.waitForLoadState('domcontentloaded');

	// --- Core launch health (hard assertions) ---
	const url = page.url();
	expect(url).toContain('screenlink://');

	const bodyText = await page.locator('body').innerText({ timeout: 15_000 });
	expect(bodyText.trim().length, 'renderer body must be non-empty').toBeGreaterThan(0);

	// --- Test-hook probe (soft while hooks lane is mid-flight) ---
	const hooksEnabled = await page.evaluate(() => {
		return (
			(globalThis as unknown as Record<string, any>).screenlink?.__e2eEnabled === true
		);
	});
	if (!hooksEnabled) {
		console.warn(
			'HOOKS-NOT-MERGED: window.screenlink.__e2eEnabled !== true — skipping hook assertions',
		);
	} else {
		const snapshot = await agent.snapshot();
		expect(snapshot, '__screenlinkTest.snapshot() should return state').not.toBeNull();
	}

	// --- Artifacts ---
	await agent.screenshot('sanity');
	const markers = await agent.drainMarkers();
	artifactDir.writeJson('markers.json', markers);
	artifactDir.writeJson('sanity-context.json', {
		url,
		hooksEnabled,
		markerCount: markers.length,
		bodySnippet: bodyText.slice(0, 200),
	});

	// --- Clean teardown ---
	const pid = agent.pid();
	await agent.close('sanity-complete');
	if (pid !== null) {
		const gone = await waitForProcessGone({ pid }, 10_000);
		expect(gone, `agent process ${pid} should be gone after close`).toBe(true);
	}
});
