/**
 * ScreenLink E2E Playwright configuration.
 *
 * Run from the repo root via `pnpm e2e` (or any of the e2e:* scripts).
 * All artifact paths are resolved absolutely so they always land under
 * e2e/artifacts regardless of cwd.
 */
import { defineConfig, type Project } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = path.join(here, 'artifacts');

// Reporters write into e2e/artifacts — make sure it exists before they flush.
fs.mkdirSync(artifactsDir, { recursive: true });

const specMatch = /.*\.spec\.ts$/;

const projects: Project[] = [
	{ name: 'critical', testMatch: specMatch, grep: /@critical/ },
	{ name: 'local-mesh', testMatch: specMatch, grep: /@local-mesh|@critical/ },
	{ name: 'media', testMatch: specMatch, grep: /@media/ },
	{ name: 'resilience', testMatch: specMatch, grep: /@resilience/ },
	{ name: 'soak', testMatch: specMatch, grep: /@soak/ },
	{ name: 'packaged', testMatch: specMatch, grep: /@packaged/ },
	{ name: 'two-machine', testMatch: specMatch, grep: /@two-machine/ },
	{ name: 'all', testMatch: specMatch },
];

export default defineConfig({
	testDir: path.join(here, 'tests'),
	outputDir: path.join(artifactsDir, 'test-results'),
	// One worker: agents share real GPU/audio/display resources; parallelism is
	// achieved by driving multiple app instances inside a single test instead.
	workers: 1,
	retries: 0,
	fullyParallel: false,
	timeout: 180_000,
	expect: { timeout: 15_000 },
	reporter: [
		['list'],
		['json', { outputFile: path.join(artifactsDir, 'results.json') }],
		['junit', { outputFile: path.join(artifactsDir, 'results.xml') }],
	],
	projects,
});
