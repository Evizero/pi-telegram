import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BROKER_LEASE_MS, LOCK_DIR, LOCK_PATH, TAKEOVER_LOCK_DIR, TOKEN_PATH } from "../shared/config.js";
import type { BrokerLease, TelegramConfig } from "../shared/types.js";
import { now, processExists, readJson, writeJson } from "../shared/utils.js";

export interface BrokerLeaseDeps {
	ownerId: string;
	startedAtMs: number;
	getConfig: () => TelegramConfig;
	getLocalBrokerSocketPath: () => string;
	getBrokerLeaseEpoch: () => number;
	setBrokerLeaseEpoch: (epoch: number) => void;
	setBrokerToken: (token: string) => void;
	makeBrokerToken: () => string;
	readLease: () => Promise<BrokerLease | undefined>;
	isLeaseLive: (lease: BrokerLease | undefined) => Promise<boolean>;
	stopBroker: () => Promise<void>;
}

async function acquireTakeoverLock(ownerId: string): Promise<boolean> {
	try {
		await mkdir(TAKEOVER_LOCK_DIR);
		await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now() });
		return true;
	} catch {
		const takeover = await readJson<{ pid?: number; updatedAtMs?: number }>(join(TAKEOVER_LOCK_DIR, "lock.json"));
		const takeoverStats = await stat(TAKEOVER_LOCK_DIR).catch(() => undefined);
		const staleEmptyTakeover = !takeover && takeoverStats && now() - takeoverStats.mtimeMs > BROKER_LEASE_MS;
		const staleOwnedTakeover = takeover && ((takeover.pid && !processExists(takeover.pid)) || (takeover.updatedAtMs && now() - takeover.updatedAtMs > BROKER_LEASE_MS));
		if (!staleEmptyTakeover && !staleOwnedTakeover) return false;
		await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		try {
			await mkdir(TAKEOVER_LOCK_DIR);
			await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now() });
			return true;
		} catch {
			return false;
		}
	}
}

export async function tryAcquireBrokerLease(deps: BrokerLeaseDeps): Promise<boolean> {
	const existing = await deps.readLease();
	if (await deps.isLeaseLive(existing)) return false;
	if (!(await acquireTakeoverLock(deps.ownerId))) return false;
	try {
		const current = await deps.readLease();
		if (await deps.isLeaseLive(current)) return false;
		await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		try {
			await mkdir(LOCK_DIR);
		} catch {
			return false;
		}
		const token = deps.makeBrokerToken();
		deps.setBrokerToken(token);
		await writeFile(TOKEN_PATH, token, { mode: 0o600 });
		const epoch = (current?.leaseEpoch ?? 0) + 1;
		deps.setBrokerLeaseEpoch(epoch);
		const lease: BrokerLease = {
			ownerId: deps.ownerId,
			pid: process.pid,
			startedAtMs: deps.startedAtMs,
			leaseEpoch: epoch,
			socketPath: deps.getLocalBrokerSocketPath(),
			leaseUntilMs: now() + BROKER_LEASE_MS,
			updatedAtMs: now(),
			botId: deps.getConfig().botId,
			schemaVersion: 1,
		};
		await writeJson(LOCK_PATH, lease);
		return true;
	} finally {
		await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function renewBrokerLease(deps: BrokerLeaseDeps): Promise<void> {
	let locked = false;
	try {
		await mkdir(TAKEOVER_LOCK_DIR);
		locked = true;
		await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId: deps.ownerId, pid: process.pid, updatedAtMs: now(), renew: true });
		const lease = await deps.readLease();
		if (!lease || lease.ownerId !== deps.ownerId || lease.leaseEpoch !== deps.getBrokerLeaseEpoch() || lease.leaseUntilMs <= now()) {
			await deps.stopBroker();
			return;
		}
		lease.leaseUntilMs = now() + BROKER_LEASE_MS;
		lease.updatedAtMs = now();
		await writeJson(LOCK_PATH, lease);
	} finally {
		if (locked) await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
	}
}
