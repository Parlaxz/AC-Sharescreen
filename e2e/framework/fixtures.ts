/**
 * Playwright fixtures for the ScreenLink E2E suite.
 *
 * - `createAgent(name?)`: launches a real app instance; every agent created
 *   during a test is auto-closed in fixture teardown (finally semantics —
 *   runs even when the test fails/times out), flushing logs and capturing
 *   failure screenshots first.
 * - `artifactDir`: per-test ArtifactWriter bound to
 *   e2e/artifacts/<testfile>-<testtitle-slug>/.
 */
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import {
	AgentController,
	launchAgent,
} from './agent.js';
import { ArtifactWriter, flushAgentLogs, writeEnvManifest } from './artifacts.js';

export type CreateAgentFn = (name?: string) => Promise<AgentController>;

export interface ScreenLinkFixtures {
	createAgent: CreateAgentFn;
	artifactDir: ArtifactWriter;
}

function slugify(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'test'
	);
}

export const test = base.extend<ScreenLinkFixtures>({
	artifactDir: async ({}, use, testInfo) => {
		// Environment manifest is written once per run (internally deduped).
		void writeEnvManifest().catch(() => { /* best effort */ });
		const fileSlug = slugify(
			path.basename(testInfo.file).replace(/\.spec\.ts$/, ''),
		);
		const titleSlug = slugify(testInfo.title);
		const dir = path.resolve(
			process.cwd(),
			'e2e',
			'artifacts',
			`${fileSlug}-${titleSlug}`,
		);
		await use(new ArtifactWriter(dir).ensure());
	},

	createAgent: async ({ artifactDir }, use, testInfo) => {
		const created: AgentController[] = [];
		let counter = 0;

		const createAgent: CreateAgentFn = async (name?: string) => {
			const finalName =
				name ??
				`${slugify(testInfo.title)}-${testInfo.workerIndex}-${++counter}-${Date.now() % 100000}`;
			const agent = await launchAgent(finalName);
			agent.artifactDir = artifactDir.dir;
			created.push(agent);
			return agent;
		};

		try {
			await use(createAgent);
		} finally {
			// Teardown in reverse creation order. Runs on success AND failure.
			for (const agent of [...created].reverse()) {
				const failed =
					testInfo.status === 'failed' ||
					testInfo.status === 'timedOut' ||
					testInfo.status === 'interrupted';
				if (failed && !agent.exitInfo()) {
					// Capture evidence before killing anything.
					try {
						await agent.screenshot(`failure-${Date.now()}`);
					} catch { /* window may already be gone */ }
				}
				if (failed) {
					try {
						artifactDir.flushAgentLogs(agent);
						await agent.processSnapshot('failure');
					} catch { /* best effort */ }
				}
				await agent.close(failed ? `fixture-teardown:${testInfo.status}` : 'fixture-teardown');
			}
		}
	},
});

export { expect };
