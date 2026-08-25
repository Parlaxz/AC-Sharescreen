/**
 * mesh.spec.ts — MULTI-AGENT MESH / MEMBERSHIP / RECOVERY scenarios
 * (Phase 3 of the E2E test plan).
 *
 * MESH-001 three-agent mesh formation            (@critical @local-mesh)
 * MESH-002 hard-kill member, offline + resync    (@critical @resilience)
 * MESH-003 graceful restart of one member        (@critical @resilience)
 * MESH-004 all three restart → persistence       (@resilience)
 * MESH-005 leave during connection establishment (@resilience)
 * MESH-006 control-loss state machine on peer kill (@resilience)
 * MESH-007 membership isolation across two groups (@local-mesh)
 *
 * Product paths verified (read, never edited):
 * - apps/desktop/src/renderer/services/group-connection-manager.ts —
 *   ConnectionState union, group-connected/group-disconnected markers,
 *   failed-retry backoff (2s/4s/8s/15s/15s).
 * - apps/desktop/src/renderer/services/initialize-app-runtime.ts — persisted
 *   groups auto-connect at startup; first group auto-selected.
 * - apps/desktop/src/main/group-store.ts — <userData>/groups.json.
 * - apps/desktop/src/renderer/services/group-sync-service.ts — membership
 *   anti-entropy (30s summary broadcast) and HLC merge rules.
 *
 * SCOPE NOTE (MESH-006): true signaling impairment needs firewall/network
 * tooling and is out of scope here (documented for the resilience wave with
 * elevated privileges). What IS testable without network tools: killing a
 * PEER process and observing the survivor's group connection state machine.
 *
 * SCOPE NOTE (announcements): stream announcement scoping / tombstones /
 * heartbeat expiry require live shares — media wave, not this lane. No media
 * is stubbed or started here.
 */
import { test, expect } from '../framework/fixtures.js';
import { killTree, waitForProcessGone } from '../framework/processes.js';
import {
	makeProfiles,
	formMesh,
	selectGroupViaRail,
	expectGroupPersisted,
	waitForGroupOverview,
	waitForAllMembersOnline,
	onlineExpectation,
	readMemberRows,
	openJoinGroupDialog,
	createGroupViaUi,
	joinGroupViaUi,
	setDisplayNameViaSettings,
	safeSnapshot,
	connectionsFor,
	MarkerTracker,
	pageErrorsOf,
	assertInteractive,
	shutdownAgent,
	closeGracefullyBounded,
	readGroupsJson,
	memberCountOfRecord,
	sleep,
	waitFor,
	CONNECTION_STATES,
} from './helpers-mesh.js';

/** Per-run unique tag so tests never collide with stale profiles. */
const RUN = `${process.pid}-${Date.now() % 100000}`;

type MemberRowSample = { name: string | null; online: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// MESH-001
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @local-mesh MESH-001: three-agent mesh formation', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const profiles = makeProfiles(`m1-${RUN}`);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		const { alice, bob, charlie, groupId } = await formMesh({
			createAgent,
			profiles,
			runTag: `m1-${RUN}`,
			onAgent: (a) => agents.push(a),
		}).catch((err) => {
			// Formation failed: flush every created agent's console traffic
			// so the sync/handshake failure is diagnosable from artifacts.
			for (const a of [...agents].reverse()) {
				try {
					const d = a.dumpLogs();
					artifactDir.writeJson(`mesh001-failure-console-${a.name}.json`, {
						rendererConsole: d.rendererConsole.filter((l) =>
							/group-control|group\.|hello|member|e2eMarker|state/i.test(l.text),
						).slice(-120),
						mainConsole: d.mainConsole.slice(-40),
					});
				} catch { /* best effort */ }
			}
			throw err;
		});
		agents.push(alice, bob, charlie!);

		// Exactly 3 member rows on every agent; every REMOTE member online
		// (the local row is exempt — product never marks self online).
		const allNames = ['Alice', 'Bob', 'Charlie'];
		for (const [agent, selfName] of [
			[alice, 'Alice'],
			[bob, 'Bob'],
			[charlie!, 'Charlie'],
		] as const) {
			const rows = await waitForAllMembersOnline(
				agent,
				onlineExpectation(selfName, allNames),
				120_000,
				`${agent.name}: exactly 3 member rows with remotes online`,
				{ nudge: true },
			);
			const names = rows.map((r) => r.name).sort();
			expect(names, `${agent.name}: expected Alice/Bob/Charlie`).toEqual(allNames);
		}

		// Snapshot: exactly ONE groupConnection entry for the group everywhere.
		for (const agent of [alice, bob, charlie!]) {
			const snap = await safeSnapshot(agent);
			expect(snap, `${agent.name}: snapshot available`).not.toBeNull();
			const entries = connectionsFor(snap, groupId);
			expect(
				entries,
				`${agent.name}: exactly one connection entry for ${groupId}, got ${JSON.stringify(snap?.groupConnections)}`,
			).toHaveLength(1);
			expect(entries[0]!.state).toBe('connected');
			artifactDir.writeJson(`mesh001-snapshot-${agent.name}.json`, snap);
		}

		// Markers: group-connected fired on every agent.
		for (const agent of [alice, bob, charlie!]) {
			const tracker = new MarkerTracker(agent);
			const elapsed = await tracker.waitFor('group-connected', 30_000);
			// Diagnostics: dump captured console traffic around markers so a
			// missing marker is diagnosable from artifacts alone.
			const dump = agent.dumpLogs();
			const markerish = [
				...dump.rendererConsole,
				...dump.mainConsole,
			].filter((l) => /e2eMarker|group-control|member online/.test(l.text));
			artifactDir.writeJson(`mesh001-console-${agent.name}.json`, {
				markerish: markerish.slice(-60),
				counts: {
					rendererConsole: dump.rendererConsole.length,
					mainConsole: dump.mainConsole.length,
					pageErrors: dump.pageErrors.length,
					requestFailed: dump.requestFailed.length,
				},
				lastRenderer: dump.rendererConsole.slice(-20).map((l) => l.text.slice(0, 160)),
				lastMain: dump.mainConsole.slice(-20).map((l) => l.text.slice(0, 160)),
			});
			artifactDir.writeJson(`mesh001-markers-${agent.name}.json`, tracker.all());
			expect(
				elapsed,
				`${agent.name}: group-connected marker should have fired (marker-ish console lines: ${JSON.stringify(markerish.slice(-10).map((l) => l.text.slice(0, 120)))})`,
			).toBeGreaterThanOrEqual(0);
		}

		await alice.screenshot(`mesh001-${alice.name}`);
		await bob.screenshot(`mesh001-${bob.name}`);
		await charlie!.screenshot(`mesh001-${charlie!.name}`);
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh001-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-002
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @resilience MESH-002: hard-kill one member, others see offline, resync on return', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `m2-${RUN}`;
	const profiles = makeProfiles(runTag);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		const { alice, bob, charlie, groupId } = await formMesh({
			createAgent,
			profiles,
			runTag,
			onAgent: (a) => agents.push(a),
		});
		const observers = [alice, bob];
		console.log('[MESH-002] mesh formed; killing charlie');

		// ── Hard-kill charlie (no graceful close) ──────────────────────
		const charliePid = charlie!.pid();
		expect(charliePid, 'charlie pid must be known').not.toBeNull();
		const tKill = Date.now();
		killTree(charliePid!);
		const gone = await waitForProcessGone({ pid: charliePid! }, 15_000);
		artifactDir.writeJson('mesh002-kill.json', {
			charliePid,
			processGone: gone,
			killedAt: new Date(tKill).toISOString(),
		});
		expect(gone, 'charlie process should be gone after killTree').toBe(true);
		// Release the dead controller (bounded) so nothing can hang later.
		await shutdownAgent(charlie!, 'mesh002-hard-killed');

		// ── Observe offline transition + guard row counts every 2s ─────
		// One sampler loop drives BOTH observations so no window is unpolled.
		const offlineAt: Record<string, number> = {};
		const violationCollector: string[] = [];
		const countSamples: Array<{ t: number; perAgent: number[] }> = [];
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const perAgent: MemberRowSample[][] = [];
				for (const agent of observers) {
					let rows: MemberRowSample[] = [];
					try {
						rows = await readMemberRows(agent);
					} catch {
						/* renderer busy */
					}
					perAgent.push(rows);
					if (rows.length > 3) {
						violationCollector.push(
							`t+${Date.now() - tKill}ms ${agent.name}: ${rows.length} rows: ${JSON.stringify(rows)}`,
						);
					}
					const row = rows.find((r) => r.name === 'Charlie');
					if (row && row.online === 'false' && !offlineAt[agent.name]) {
						offlineAt[agent.name] = Date.now() - tKill;
						console.log(
							`[MESH-002] ${agent.name} saw charlie OFFLINE after ${offlineAt[agent.name]}ms`,
						);
					}
				}
				countSamples.push({
					t: Date.now() - tKill,
					perAgent: perAgent.map((r) => r.length),
				});
				if (observers.every((a) => offlineAt[a.name])) break;
				await sleep(2_000);
			}
		}

		artifactDir.writeJson('mesh002-offline-detection.json', {
			offlineDetectionLatencyMs: offlineAt,
			countSamples,
			violations: violationCollector,
		});
		console.log(
			`[MESH-002] offline-detection latency (ms): ${JSON.stringify(offlineAt)}`,
		);
		expect(
			Object.keys(offlineAt),
			'both alice and bob must observe charlie offline within 120s',
		).toHaveLength(2);

		// ── Relaunch charlie on the SAME profile ───────────────────────
		console.log('[MESH-002] relaunching charlie (same profile)');
		const charlie2 = await createAgent(profiles.charlie);
		agents.push(charlie2);
		await charlie2.waitForTestId('app-root', 60_000);

		// Persisted membership: the group must still exist after the hard kill.
		await expectGroupPersisted(charlie2, groupId, `Mesh ${runTag}`);

		// ── Resync: observers return to 3 rows with remotes online; counts
		// never exceed 3. (Self row is exempt — product never marks self
		// online.)
		const tRelaunch = Date.now();
		const resync: Record<string, number> = {};
		const remoteNamesFor: Record<string, string[]> = {
			[alice.name]: ['Bob', 'Charlie'],
			[bob.name]: ['Alice', 'Charlie'],
		};
		{
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				for (const agent of observers) {
					if (resync[agent.name]) continue;
					let rows: MemberRowSample[] = [];
					try {
						rows = await readMemberRows(agent);
					} catch {
						/* renderer busy */
					}
					if (rows.length > 3) {
						violationCollector.push(
							`recovery t+${Date.now() - tRelaunch}ms ${agent.name}: ${rows.length} rows`,
						);
					}
					const remotesOk = (remoteNamesFor[agent.name] ?? []).every((n) =>
						rows.find((r) => r.name === n)?.online === 'true',
					);
					if (rows.length === 3 && remotesOk) {
						resync[agent.name] = Date.now() - tRelaunch;
						console.log(
							`[MESH-002] ${agent.name} resynced after ${resync[agent.name]}ms`,
						);
					}
				}
				if (observers.every((a) => resync[a.name])) break;
				await sleep(2_000);
			}
		}

		artifactDir.writeJson('mesh002-resync.json', {
			resyncLatencyMs: resync,
			recoveryViolations: violationCollector,
		});
		console.log(
			`[MESH-002] resync latency after relaunch (ms): ${JSON.stringify(resync)}`,
		);
		expect(
			Object.keys(resync),
			'alice and bob must both return to 3 online members within 120s',
		).toHaveLength(2);
		expect(
			violationCollector,
			`member-row count must NEVER exceed 3 during recovery: ${JSON.stringify(violationCollector.slice(0, 5))}`,
		).toHaveLength(0);

		// Charlie is back online from his own view too.
		await selectGroupViaRail(charlie2, `Mesh ${runTag}`);
		await waitForGroupOverview(charlie2);
		await waitForAllMembersOnline(
			charlie2,
			onlineExpectation('Charlie', ['Alice', 'Bob', 'Charlie']),
			90_000,
			'charlie(relaunched): 3 member rows, remotes online',
			{ nudge: true },
		);

		// No duplicate groupConnection entries anywhere post-recovery.
		for (const agent of [...observers, charlie2]) {
			const snap = await safeSnapshot(agent);
			const entries = connectionsFor(snap, groupId);
			expect(
				entries,
				`${agent.name}: exactly one connection entry post-recovery, got ${JSON.stringify(snap?.groupConnections)}`,
			).toHaveLength(1);
			artifactDir.writeJson(`mesh002-post-recovery-${agent.name}.json`, snap);
		}
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh002-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-003
// ─────────────────────────────────────────────────────────────────────────────

test('@critical @resilience MESH-003: graceful restart of one member while others online', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(480_000);
	const runTag = `m3-${RUN}`;
	const profiles = makeProfiles(runTag);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		const { alice, bob, charlie, groupId } = await formMesh({
			createAgent,
			profiles,
			runTag,
			onAgent: (a) => agents.push(a),
		});

		// ── Graceful close of alice (bounded). PRODUCT FINDING: with a live
		// group control connection the graceful close can hang indefinitely;
		// a hang is recorded as an artifact and worked around with killTree
		// (persistence is disk-based, so restart assertions remain valid).
		const closeResult = await closeGracefullyBounded(alice, 'mesh003-graceful');
		artifactDir.writeJson('mesh003-alice-exit.json', {
			...closeResult.exit,
			gracefulCloseHung: closeResult.hung,
		});
		if (closeResult.hung) {
			console.warn(
				'[MESH-003] DEFECT SUSPECT: graceful close of alice did not complete within 75s while a group connection was live — force-killed. See mesh003-alice-exit.json',
			);
		}

		// ── Relaunch SAME profile ──────────────────────────────────────
		const alice2 = await createAgent(profiles.alice);
		agents.push(alice2);
		await alice2.waitForTestId('app-root', 60_000);

		// Persisted membership survives the restart.
		await expectGroupPersisted(alice2, groupId, `Mesh ${runTag}`);

		// Reconnect marker fires again on the fresh instance.
		const tracker = new MarkerTracker(alice2);
		const markerElapsed = await tracker.waitFor('group-connected', 90_000);
		artifactDir.writeJson('mesh003-alice2-markers.json', tracker.all());
		expect(
			markerElapsed,
			'group-connected must fire again after relaunch',
		).toBeGreaterThanOrEqual(0);
		console.log(`[MESH-003] reconnect marker after relaunch: ${markerElapsed}ms`);

		// Back on the group view: 3 rows with remotes online, no duplicates.
		await selectGroupViaRail(alice2, `Mesh ${runTag}`);
		await waitForGroupOverview(alice2);
		await waitForAllMembersOnline(
			alice2,
			onlineExpectation('Alice', ['Alice', 'Bob', 'Charlie']),
			90_000,
			'alice(relaunched): 3 member rows, remotes online',
			{ nudge: true },
		);

		for (const [agent, selfName] of [
			[bob, 'Bob'],
			[charlie!, 'Charlie'],
		] as const) {
			await waitForAllMembersOnline(
				agent,
				onlineExpectation(selfName, ['Alice', 'Bob', 'Charlie']),
				90_000,
				`${agent.name}: back to 3 member rows with remotes online`,
				{ nudge: true },
			);
			const snap = await safeSnapshot(agent);
			const entries = connectionsFor(snap, groupId);
			expect(
				entries,
				`${agent.name}: exactly one connection entry, got ${JSON.stringify(snap?.groupConnections)}`,
			).toHaveLength(1);
		}

		const snap = await safeSnapshot(alice2);
		artifactDir.writeJson('mesh003-alice2-snapshot.json', snap);
		const entries = connectionsFor(snap, groupId);
		expect(
			entries,
			`alice snapshot.groupConnections must hold exactly 1 entry for the group, got ${JSON.stringify(snap?.groupConnections)}`,
		).toHaveLength(1);
		expect(entries[0]!.state).toBe('connected');
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh003-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-004
// ─────────────────────────────────────────────────────────────────────────────

test('@resilience MESH-004: all three restart → persistence + resync', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(600_000);
	const runTag = `m4-${RUN}`;
	const profiles = makeProfiles(runTag);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		const mesh = await formMesh({
			createAgent,
			profiles,
			runTag,
			onAgent: (a) => agents.push(a),
		});
		const { groupId } = mesh;
		const trio = [mesh.alice, mesh.bob, mesh.charlie!];

		// Record userData paths BEFORE closing (unreachable once processes die).
		const userDataPaths: Record<string, string> = {};
		for (const agent of trio) {
			userDataPaths[agent.name] = await agent.mainEval((electron) =>
				electron.app.getPath('userData'),
			);
		}
		artifactDir.writeJson('mesh004-userdata-paths.json', userDataPaths);

		// Graceful close of all three (bounded — see MESH-003 note).
		for (const agent of trio) {
			const closeResult = await closeGracefullyBounded(
				agent,
				`mesh004-graceful:${agent.name}`,
			);
			artifactDir.writeJson(`mesh004-exit-${agent.name}.json`, {
				...closeResult.exit,
				gracefulCloseHung: closeResult.hung,
			});
			if (closeResult.hung) {
				console.warn(
					`[MESH-004] DEFECT SUSPECT: graceful close of ${agent.name} did not complete within 75s — force-killed.`,
				);
			}
		}

		// Sequential relaunch; each must show its persisted group.
		console.log('[MESH-004] relaunching all three sequentially');
		const relaunched: Record<
			string,
			import('../framework/agent.js').AgentController
		> = {};
		for (const key of ['alice', 'bob', 'charlie'] as const) {
			const agent = await createAgent(profiles[key]);
			agents.push(agent);
			relaunched[key] = agent;
			await agent.waitForTestId('app-root', 60_000);
			await expectGroupPersisted(agent, groupId, `Mesh ${runTag}`);
		}

		// Each reaches 3 member rows (remotes online) within 120s.
		const selfNames = { alice: 'Alice', bob: 'Bob', charlie: 'Charlie' } as const;
		for (const key of ['alice', 'bob', 'charlie'] as const) {
			const agent = relaunched[key]!;
			await selectGroupViaRail(agent, `Mesh ${runTag}`);
			await waitForGroupOverview(agent);
			await waitForAllMembersOnline(
				agent,
				onlineExpectation(selfNames[key], ['Alice', 'Bob', 'Charlie']),
				120_000,
				`${agent.name}(relaunched): 3 member rows with remotes online within 120s`,
				{ nudge: true },
			);
			console.log(`[MESH-004] ${agent.name} resynced to 3 members`);
		}

		// groups.json on every profile contains the group with 3 member records
		// (structure-tolerant: assert member-count keys, not exact schema).
		for (const key of ['alice', 'bob', 'charlie'] as const) {
			const records = readGroupsJson(userDataPaths[profiles[key]]!);
			const record = records.find((r) => r['groupId'] === groupId);
			expect(
				record,
				`${key} groups.json must contain group ${groupId}: ${JSON.stringify(records.map((r) => r['groupId']))}`,
			).toBeTruthy();
			const count = memberCountOfRecord(record!);
			expect(
				count,
				`${key} groups.json record for ${groupId} must hold 3 members, got ${count}`,
			).toBe(3);
		}
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh004-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-005
// ─────────────────────────────────────────────────────────────────────────────

test('@resilience MESH-005: leave group during connection establishment', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(360_000);
	const runTag = `m5-${RUN}`;
	const profiles = makeProfiles(runTag);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		// Alice creates the group; bob joins and IMMEDIATELY leaves via UI.
		const alice = await createAgent(profiles.alice);
		agents.push(alice);
		await alice.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(alice, 'Alice');
		const { groupId, inviteLink } = await createGroupViaUi(
			alice,
			`Mesh ${runTag}`,
		);

		const bob = await createAgent(profiles.bob);
		agents.push(bob);
		await bob.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(bob, 'Bob');

		const bobMarkers = new MarkerTracker(bob);
		await openJoinGroupDialog(bob);
		await bob.fillTestId('join-invite-input', inviteLink);
		const tSubmit = Date.now();
		await bob.clickTestId('join-group-submit', 15_000);

		// Race: navigate to Group settings as soon as the sidebar nav appears
		// (selectedGroupId is set synchronously inside the join action), then
		// confirm leave — ideally BEFORE the group-connected marker fires.
		const settingsNav = bob.page.getByRole('button', { name: 'Group settings' });
		await settingsNav.waitFor({ state: 'visible', timeout: 30_000 });
		await settingsNav.click({ timeout: 10_000 });
		await bob.clickTestId('leave-group-button', 30_000);
		await bob.waitForTestId('leave-confirm-dialog', 15_000);
		await bob.clickTestId('leave-confirm-button', 15_000);
		const leaveCompletedMs = Date.now() - tSubmit;

		// Did the connection win the race?
		await bobMarkers.drain();
		const connectedBeforeLeave = bobMarkers.has('group-connected');
		artifactDir.writeJson('mesh005-race-outcome.json', {
			leaveCompletedMs,
			groupConnectedBeforeLeave: connectedBeforeLeave,
			bobMarkers: bobMarkers.all(),
		});
		console.log(
			`[MESH-005] race outcome: leave completed in ${leaveCompletedMs}ms; group-connected before leave = ${connectedBeforeLeave}`,
		);

		// Bob ends with NO lingering groupConnection entry for the group (poll 15s).
		{
			const deadline = Date.now() + 15_000;
			let lingering: ReturnType<typeof connectionsFor> = [];
			for (;;) {
				const snap = await safeSnapshot(bob);
				lingering = connectionsFor(snap, groupId);
				if (lingering.length === 0) break;
				if (Date.now() >= deadline) break;
				await sleep(1_000);
			}
			const finalSnap = await safeSnapshot(bob);
			artifactDir.writeJson('mesh005-bob-final-snapshot.json', finalSnap);
			expect(
				lingering as unknown[],
				`bob must have no lingering groupConnection for ${groupId}, got ${JSON.stringify((finalSnap?.groupConnections ?? []).filter((c) => c.groupId === groupId))}`,
			).toHaveLength(0);
		}

		// No unhandled pageerror; app stays interactive.
		const errors = pageErrorsOf(bob);
		artifactDir.writeJson('mesh005-bob-pageerrors.json', errors);
		expect(errors, `bob pageerror events: ${JSON.stringify(errors)}`).toHaveLength(0);
		await assertInteractive(bob);
		await bob.clickTestId('nav-home', 15_000);

		// Alice must prune bob and STAY pruned. Fixed-interval polls race the
		// tombstone delivery window, so poll until the list is stable: two
		// consecutive polls 10s apart that both show only Alice, within 90s.
		const pollAlice = async (): Promise<MemberRowSample[]> => readMemberRows(alice);
		const stableRows = await waitFor(
			async () => {
				const rowsNow = await pollAlice();
				await sleep(10_000);
				const rowsLater = await pollAlice();
				for (const [label, rows] of [
					['first', rowsNow],
					['second', rowsLater],
				] as const) {
					const bobRow = rows.find((r) => r.name === 'Bob');
					expect(
						bobRow?.online,
						`alice must never show bob ONLINE (${label} poll): ${JSON.stringify(rows)}`,
					).not.toBe('true');
				}
				const namesNow = JSON.stringify(rowsNow.map((r) => [r.name, r.online]));
				if (namesNow !== JSON.stringify(rowsLater.map((r) => [r.name, r.online]))) return null;
				artifactDir.writeJson('mesh005-alice-members.json', {
					firstPoll: rowsNow,
					secondPollAfter10s: rowsLater,
				});
				return rowsLater;
			},
			{ timeout: 90_000, interval: 1_000, label: 'alice member list stabilizes after bob leave' },
		);
		expect(stableRows.map((r) => r.name), 'alice must end with only herself after bob left').toEqual(['Alice']);
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh005-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-006
// ─────────────────────────────────────────────────────────────────────────────

test('@resilience MESH-006: supervisor behavior on control loss caused by killing the PEER', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(300_000);
	const runTag = `m6-${RUN}`;
	const profiles = makeProfiles(runTag);
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		// Honest scope note: true signaling impairment requires firewall/network
		// tooling — out of scope here (documented for the resilience wave with
		// elevated privileges). Instead: kill the PEER mid-session and verify
		// the survivor's group connection does NOT get permanently stuck
		// "failed".
		const { alice, bob, groupId } = await formMesh({
			createAgent,
			profiles,
			runTag,
			includeCharlie: false,
			onAgent: (a) => agents.push(a),
		});

		const bobPid = bob.pid();
		expect(bobPid, 'bob pid must be known').not.toBeNull();
		const tKill = Date.now();
		killTree(bobPid!);
		const gone = await waitForProcessGone({ pid: bobPid! }, 15_000);
		expect(gone, 'bob process should be gone after killTree').toBe(true);
		await shutdownAgent(bob, 'mesh006-hard-killed');

		// Sample alice's connection state for the group every 3s over 60s.
		const observed: Array<{ t: number; state: string | null; onlinePeers: number }> = [];
		{
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				const snap = await safeSnapshot(alice);
				const entries = connectionsFor(snap, groupId);
				observed.push({
					t: Date.now() - tKill,
					state: entries.length > 0 ? (entries[0]!.state ?? null) : '<absent>',
					onlinePeers: entries[0]?.onlinePeers?.length ?? 0,
				});
				await sleep(3_000);
			}
		}
		artifactDir.writeJson('mesh006-state-observations.json', observed);
		console.log(
			`[MESH-006] alice connection states after peer kill: ${JSON.stringify(observed.map((o) => `${o.t}ms=${o.state}`))}`,
		);

		// Every observed state must be a known enum value (or transiently
		// absent while the manager rebuilds its states map).
		const knownStates: string[] = [...CONNECTION_STATES];
		const unknown = observed.filter(
			(o) => o.state !== null && o.state !== '<absent>' && !knownStates.includes(o.state),
		);
		expect(
			unknown,
			`unknown connection states observed: ${JSON.stringify(unknown)}`,
		).toHaveLength(0);
		expect(observed.length, 'at least one state observation recorded').toBeGreaterThan(0);

		// Not permanently stuck "failed": final observed state must not be failed.
		const finalState = observed[observed.length - 1]!.state;
		artifactDir.writeJson('mesh006-final-state.json', { finalState });
		expect(
			finalState,
			`alice's connection must not end stuck "failed" (observed: ${JSON.stringify(observed.map((o) => o.state))})`,
		).not.toBe('failed');

		// App stays interactive throughout.
		await assertInteractive(alice);
		const snap = await safeSnapshot(alice);
		expect(snap, 'snapshot still available at end').not.toBeNull();
		artifactDir.writeJson('mesh006-alice-final-snapshot.json', snap);
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh006-done');
		}
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// MESH-007
// ─────────────────────────────────────────────────────────────────────────────

test('@local-mesh MESH-007: membership isolation across two groups', async ({
	createAgent,
	artifactDir,
}) => {
	test.setTimeout(420_000);
	const runTag = `m7-${RUN}`;
	const profiles = makeProfiles(runTag);
	const nameGA = `Alpha ${runTag}`;
	const nameGB = `Beta ${runTag}`;
	const agents: import('../framework/agent.js').AgentController[] = [];
	try {
		// Alice creates GA then GB.
		const alice = await createAgent(profiles.alice);
		agents.push(alice);
		await alice.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(alice, 'Alice');
		const ga = await createGroupViaUi(alice, nameGA);
		const gb = await createGroupViaUi(alice, nameGB);
		artifactDir.writeJson('mesh007-groups.json', { ga, gb });

		// Bob joins GA only; charlie joins GB only.
		const bob = await createAgent(profiles.bob);
		agents.push(bob);
		await bob.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(bob, 'Bob');
		await joinGroupViaUi(bob, ga.inviteLink);

		const charlie = await createAgent(profiles.charlie);
		agents.push(charlie);
		await charlie.waitForTestId('app-root', 60_000);
		await setDisplayNameViaSettings(charlie, 'Charlie');
		await joinGroupViaUi(charlie, gb.inviteLink);

		// Alice, in GA view: sees Bob but NOT Charlie.
		await selectGroupViaRail(alice, nameGA);
		await waitForGroupOverview(alice);
		{
			const rows = await waitForAllMembersOnline(
				alice,
				onlineExpectation('Alice', ['Alice', 'Bob']),
				90_000,
				'alice/GA: exactly 2 member rows (Alice+Bob)',
				{ nudge: true },
			);
			const names = rows.map((r) => r.name).sort();
			expect(names).toEqual(['Alice', 'Bob']);
		}

		// Alice, in GB view: sees Charlie but NOT Bob.
		await selectGroupViaRail(alice, nameGB);
		await waitForGroupOverview(alice);
		{
			const rows = await waitForAllMembersOnline(
				alice,
				onlineExpectation('Alice', ['Alice', 'Charlie']),
				90_000,
				'alice/GB: exactly 2 member rows (Alice+Charlie)',
				{ nudge: true },
			);
			const names = rows.map((r) => r.name).sort();
			expect(names).toEqual(['Alice', 'Charlie']);
		}

		// Bob sees only GA (single group, Alice+Bob); charlie only GB.
		{
			const snap = await safeSnapshot(bob);
			artifactDir.writeJson('mesh007-bob-snapshot.json', snap);
			expect(
				(snap?.groups ?? []).map((g) => g.id),
				'bob must know exactly one group (GA)',
			).toEqual([ga.groupId]);
		}
		await selectGroupViaRail(bob, nameGA);
		await waitForGroupOverview(bob);
		{
			const rows = await waitForAllMembersOnline(
				bob,
				onlineExpectation('Bob', ['Alice', 'Bob']),
				90_000,
				'bob/GA: exactly 2 member rows',
				{ nudge: true },
			);
			expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
		}
		{
			const snap = await safeSnapshot(charlie);
			artifactDir.writeJson('mesh007-charlie-snapshot.json', snap);
			expect(
				(snap?.groups ?? []).map((g) => g.id),
				'charlie must know exactly one group (GB)',
			).toEqual([gb.groupId]);
		}
		await selectGroupViaRail(charlie, nameGB);
		await waitForGroupOverview(charlie);
		{
			const rows = await waitForAllMembersOnline(
				charlie,
				onlineExpectation('Charlie', ['Alice', 'Charlie']),
				90_000,
				'charlie/GB: exactly 2 member rows',
				{ nudge: true },
			);
			expect(rows.map((r) => r.name).sort()).toEqual(['Alice', 'Charlie']);
		}

		// Snapshot cross-group leakage check (shape-tolerant): alice runs BOTH
		// group connections by design (manager connects every joined group), so
		// the honest assertions are: exactly one entry per known group, NO
		// unknown groupIds, no duplicate entries, and zero active streams
		// (no media anywhere in this lane).
		const snap = await safeSnapshot(alice);
		artifactDir.writeJson('mesh007-alice-snapshot.json', snap);
		{
			const known = new Set([ga.groupId, gb.groupId]);
			const conns = snap?.groupConnections ?? [];
			const unknownLeak = conns.filter((c) => !known.has(c.groupId ?? ''));
			expect(
				unknownLeak,
				`no cross-group leakage into groupConnections: ${JSON.stringify(unknownLeak)}`,
			).toHaveLength(0);
			expect(conns, 'exactly one connection per known group').toHaveLength(2);
			expect(new Set(conns.map((c) => c.groupId)).size, 'no duplicate groupIds').toBe(2);
			expect(
				snap?.activeStreams ?? [],
				'no active streams may leak across groups without any share',
			).toHaveLength(0);
		}

		await alice.screenshot('mesh007-alice-gb');
	} finally {
		for (const agent of [...agents].reverse()) {
			await shutdownAgent(agent, 'mesh007-done');
		}
	}
});
