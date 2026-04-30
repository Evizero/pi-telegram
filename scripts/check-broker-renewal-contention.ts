import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerHeartbeatState, BROKER_RENEWAL_CONTENTION_DIAGNOSTIC_THRESHOLD, runBrokerHeartbeatCycle, type BrokerDiagnosticEvent } from "../src/broker/heartbeat.js";
import { BrokerRenewalContentionError, isBrokerRenewalContentionError, renewBrokerLease } from "../src/broker/lease.js";
import { BROKER_LEASE_MS } from "../src/broker/policy.js";
import { BROKER_DIR, LOCK_PATH, TAKEOVER_LOCK_DIR, configureBrokerScope, configureBrokerScopeForBase } from "../src/shared/paths.js";
import type { BrokerLease } from "../src/broker/types.js";
import type { TelegramConfig } from "../src/shared/config-types.js";
import { InvalidDurableJsonError, ensurePrivateDir, now, readJson, writeJson } from "../src/shared/utils.js";

const ownerId = "owner-renew";
const leaseEpoch = 7;

function liveLease(overrides: Partial<BrokerLease> = {}): BrokerLease {
	return {
		schemaVersion: 1,
		ownerId,
		pid: process.pid,
		startedAtMs: now() - 1000,
		leaseEpoch,
		socketPath: "/tmp/broker.sock",
		leaseUntilMs: now() + BROKER_LEASE_MS,
		updatedAtMs: now(),
		...overrides,
	};
}

function leaseDeps(stopBroker: () => Promise<void> = async () => undefined) {
	return {
		ownerId,
		startedAtMs: now() - 1000,
		getConfig: (): TelegramConfig => ({ botId: 123 }),
		getLocalBrokerSocketPath: () => "/tmp/broker.sock",
		getBrokerLeaseEpoch: () => leaseEpoch,
		setBrokerLeaseEpoch: () => undefined,
		setBrokerToken: () => undefined,
		makeBrokerToken: () => "token",
		readLease: () => readJson<BrokerLease>(LOCK_PATH),
		isLeaseLive: async (lease: BrokerLease | undefined) => Boolean(lease && lease.leaseUntilMs > now()),
		stopBroker,
	};
}

async function withBrokerDir(run: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-renewal-"));
	configureBrokerScopeForBase(dir);
	try {
		await ensurePrivateDir(BROKER_DIR);
		await run();
	} finally {
		configureBrokerScope();
		await rm(dir, { recursive: true, force: true });
	}
}

async function writeCurrentLease(lease: BrokerLease): Promise<void> {
	await writeJson(LOCK_PATH, lease);
}

async function writeLiveTakeoverLock(): Promise<void> {
	await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId: "contender", pid: process.pid, updatedAtMs: now() });
}

async function checkLiveTakeoverContentionIsClassifiedWithoutStandDown(): Promise<void> {
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease());
		await writeLiveTakeoverLock();
		let stopCalls = 0;
		await assert.rejects(
			() => renewBrokerLease(leaseDeps(async () => { stopCalls += 1; })),
			(error: unknown) => isBrokerRenewalContentionError(error),
		);
		assert.equal(stopCalls, 0);
		const lease = await readJson<BrokerLease>(LOCK_PATH);
		assert.equal(lease?.ownerId, ownerId);
		assert.equal(lease?.leaseEpoch, leaseEpoch);
	});
}

async function checkTrueLeaseLossStillStandsDown(): Promise<void> {
	await withBrokerDir(async () => {
		let stopCalls = 0;
		await renewBrokerLease(leaseDeps(async () => { stopCalls += 1; }));
		assert.equal(stopCalls, 1, "missing lease should stand down");
	});
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease({ ownerId: "other-owner" }));
		await writeLiveTakeoverLock();
		let stopCalls = 0;
		await renewBrokerLease(leaseDeps(async () => { stopCalls += 1; }));
		assert.equal(stopCalls, 1, "mismatched owner should stand down");
	});
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease({ leaseEpoch: leaseEpoch + 1 }));
		await writeLiveTakeoverLock();
		let stopCalls = 0;
		await renewBrokerLease(leaseDeps(async () => { stopCalls += 1; }));
		assert.equal(stopCalls, 1, "mismatched epoch should stand down");
	});
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease({ leaseUntilMs: now() - 1 }));
		let stopCalls = 0;
		await renewBrokerLease(leaseDeps(async () => { stopCalls += 1; }));
		assert.equal(stopCalls, 1, "expired lease should stand down");
	});
}

async function checkStaleTakeoverLockRecoveryStillRenews(): Promise<void> {
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease({ updatedAtMs: now() - 2000 }));
		await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId: "dead-contender", updatedAtMs: now() - BROKER_LEASE_MS - 1000 });
		let stopCalls = 0;
		await renewBrokerLease(leaseDeps(async () => { stopCalls += 1; }));
		assert.equal(stopCalls, 0);
		const lease = await readJson<BrokerLease>(LOCK_PATH);
		assert.equal(lease?.ownerId, ownerId);
		assert.equal(lease?.leaseEpoch, leaseEpoch);
		assert.ok((lease?.updatedAtMs ?? 0) > now() - 1000, "stale takeover lock should not prevent renewal");
		assert.equal(await readJson(join(TAKEOVER_LOCK_DIR, "lock.json")), undefined, "renewal should release the takeover lock it recovered");
	});
}

async function checkInvalidBrokerLeaseDoesNotGetOverwritten(): Promise<void> {
	await withBrokerDir(async () => {
		await writeJson(LOCK_PATH, { schemaVersion: 1, ownerId: ownerId, pid: process.pid, startedAtMs: now(), socketPath: "/tmp/broker.sock", leaseUntilMs: now() - 1, updatedAtMs: now() });
		await assert.rejects(
			() => renewBrokerLease(leaseDeps()),
			(error: unknown) => error instanceof InvalidDurableJsonError && error.message.includes(LOCK_PATH),
		);
		const raw = await readFile(LOCK_PATH, "utf8");
		assert.match(raw, /socketPath/);
		assert.doesNotMatch(raw, /leaseEpoch/);
	});
}

async function checkInvalidTakeoverLockIsReportedAndPreserved(): Promise<void> {
	await withBrokerDir(async () => {
		await writeCurrentLease(liveLease({ leaseUntilMs: now() - 1 }));
		await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId: "contender" });
		await assert.rejects(
			() => renewBrokerLease(leaseDeps()),
			(error: unknown) => error instanceof InvalidDurableJsonError && error.message.includes(join(TAKEOVER_LOCK_DIR, "lock.json")),
		);
		const takeover = await readJson<Record<string, unknown>>(join(TAKEOVER_LOCK_DIR, "lock.json"));
		assert.deepEqual(takeover, { ownerId: "contender" });
	});
}

async function checkHeartbeatOneOffContentionDoesNotAdvanceFailureOrStandDown(): Promise<void> {
	const state = createBrokerHeartbeatState();
	let stopCalls = 0;
	let maintenanceCalls = 0;
	const diagnostics: BrokerDiagnosticEvent[] = [];
	await runBrokerHeartbeatCycle(state, {
		renewBrokerLease: async () => { throw new BrokerRenewalContentionError(); },
		isBrokerActive: async () => true,
		runMaintenance: async () => { maintenanceCalls += 1; },
		handleStaleBrokerError: async () => { throw new Error("must not handle benign contention as stale"); },
		stopBroker: async () => { stopCalls += 1; },
		reportDiagnostic: (event) => { diagnostics.push(event); },
	});
	assert.equal(state.failures, 0);
	assert.equal(state.renewalContentions, 1);
	assert.equal(stopCalls, 0);
	assert.equal(maintenanceCalls, 0);
	assert.deepEqual(diagnostics, []);
}

async function checkRepeatedContentionReportsPiSafeDiagnosticOnce(): Promise<void> {
	const state = createBrokerHeartbeatState();
	let stopCalls = 0;
	const diagnostics: BrokerDiagnosticEvent[] = [];
	for (let index = 0; index < BROKER_RENEWAL_CONTENTION_DIAGNOSTIC_THRESHOLD + 2; index += 1) {
		await runBrokerHeartbeatCycle(state, {
			renewBrokerLease: async () => { throw new BrokerRenewalContentionError(); },
			isBrokerActive: async () => true,
			runMaintenance: async () => undefined,
			handleStaleBrokerError: async () => { throw new Error("must not handle benign contention as stale"); },
			stopBroker: async () => { stopCalls += 1; },
			reportDiagnostic: (event) => { diagnostics.push(event); },
		});
	}
	assert.equal(state.failures, 0);
	assert.equal(stopCalls, 0);
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]?.notify, true);
	assert.equal(diagnostics[0]?.display, false);
	assert.match(diagnostics[0]?.message ?? "", /repeated lease-renewal contention/);
}

async function checkGenericHeartbeatFailuresUseDiagnosticsAndStandDownAfterTwo(): Promise<void> {
	const state = createBrokerHeartbeatState();
	let stopCalls = 0;
	const diagnostics: BrokerDiagnosticEvent[] = [];
	const deps = {
		renewBrokerLease: async () => { throw new Error("disk full"); },
		isBrokerActive: async () => true,
		runMaintenance: async () => undefined,
		handleStaleBrokerError: async () => { throw new Error("must not handle generic error as stale"); },
		stopBroker: async () => { stopCalls += 1; },
		reportDiagnostic: (event: BrokerDiagnosticEvent) => { diagnostics.push(event); },
	};
	await runBrokerHeartbeatCycle(state, deps);
	await runBrokerHeartbeatCycle(state, deps);
	assert.equal(state.failures, 2);
	assert.equal(stopCalls, 1);
	assert.equal(diagnostics.length, 2);
	assert.equal(diagnostics[0]?.notify, false);
	assert.equal(diagnostics[0]?.display, false);
	assert.equal(diagnostics[1]?.notify, true);
	assert.equal(diagnostics[1]?.display, true);
}

async function checkMaintenanceFailuresUseDiagnosticsAndStandDownAfterTwo(): Promise<void> {
	const state = createBrokerHeartbeatState();
	let stopCalls = 0;
	const diagnostics: BrokerDiagnosticEvent[] = [];
	const deps = {
		renewBrokerLease: async () => undefined,
		isBrokerActive: async () => true,
		runMaintenance: async () => { throw new Error("maintenance failed"); },
		handleStaleBrokerError: async () => { throw new Error("must not handle generic error as stale"); },
		stopBroker: async () => { stopCalls += 1; },
		reportDiagnostic: (event: BrokerDiagnosticEvent) => { diagnostics.push(event); },
	};
	await runBrokerHeartbeatCycle(state, deps);
	await runBrokerHeartbeatCycle(state, deps);
	assert.equal(state.failures, 2);
	assert.equal(stopCalls, 1);
	assert.equal(diagnostics.length, 2);
	assert.equal(diagnostics[1]?.notify, true);
	assert.equal(diagnostics[1]?.display, true);
}

async function checkRejectedStandDownIsReportedWithoutRejectingHeartbeatCycle(): Promise<void> {
	const state = createBrokerHeartbeatState();
	const diagnostics: BrokerDiagnosticEvent[] = [];
	const deps = {
		renewBrokerLease: async () => { throw new Error("disk full"); },
		isBrokerActive: async () => true,
		runMaintenance: async () => undefined,
		handleStaleBrokerError: async () => { throw new Error("must not handle generic error as stale"); },
		stopBroker: async () => { throw new Error("close failed"); },
		reportDiagnostic: (event: BrokerDiagnosticEvent) => { diagnostics.push(event); },
	};
	await runBrokerHeartbeatCycle(state, deps);
	await assert.doesNotReject(() => runBrokerHeartbeatCycle(state, deps));
	assert.equal(state.failures, 2);
	assert.equal(diagnostics.length, 3);
	assert.match(diagnostics[2]?.message ?? "", /Failed to stop broker after heartbeat failure: close failed/);
	assert.equal(diagnostics[2]?.notify, true);
	assert.equal(diagnostics[2]?.display, true);
}

async function checkHeartbeatCyclesDoNotOverlap(): Promise<void> {
	const state = createBrokerHeartbeatState();
	let renewCalls = 0;
	let releaseRenewal!: () => void;
	const firstCycle = runBrokerHeartbeatCycle(state, {
		renewBrokerLease: async () => {
			renewCalls += 1;
			await new Promise<void>((resolve) => { releaseRenewal = resolve; });
		},
		isBrokerActive: async () => true,
		runMaintenance: async () => undefined,
		handleStaleBrokerError: async () => undefined,
		stopBroker: async () => undefined,
		reportDiagnostic: () => undefined,
	});
	await runBrokerHeartbeatCycle(state, {
		renewBrokerLease: async () => { renewCalls += 1; },
		isBrokerActive: async () => true,
		runMaintenance: async () => undefined,
		handleStaleBrokerError: async () => undefined,
		stopBroker: async () => undefined,
		reportDiagnostic: () => undefined,
	});
	assert.equal(renewCalls, 1);
	releaseRenewal();
	await firstCycle;
	assert.equal(state.inFlight, false);
}

await checkLiveTakeoverContentionIsClassifiedWithoutStandDown();
await checkTrueLeaseLossStillStandsDown();
await checkStaleTakeoverLockRecoveryStillRenews();
await checkInvalidBrokerLeaseDoesNotGetOverwritten();
await checkInvalidTakeoverLockIsReportedAndPreserved();
await checkHeartbeatOneOffContentionDoesNotAdvanceFailureOrStandDown();
await checkRepeatedContentionReportsPiSafeDiagnosticOnce();
await checkGenericHeartbeatFailuresUseDiagnosticsAndStandDownAfterTwo();
await checkMaintenanceFailuresUseDiagnosticsAndStandDownAfterTwo();
await checkRejectedStandDownIsReportedWithoutRejectingHeartbeatCycle();
await checkHeartbeatCyclesDoNotOverlap();
console.log("Broker renewal contention checks passed");
