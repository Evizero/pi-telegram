import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LOCK_DIR, LOCK_PATH, TAKEOVER_LOCK_DIR, TOKEN_PATH } from "../shared/paths.js";
import { BROKER_LEASE_MS } from "./policy.js";
import type { TelegramConfig } from "../shared/config-types.js";
import type { BrokerLease } from "./types.js";
import { invalidDurableJson, isRecord, now, processExists, readJson, writeJson } from "../shared/utils.js";

export const STALE_BROKER_ERROR_MESSAGE = "stale_broker";
export const BROKER_RENEWAL_CONTENTION_MESSAGE = "broker_renewal_contention";

export class StaleBrokerError extends Error {
	constructor() {
		super(STALE_BROKER_ERROR_MESSAGE);
		this.name = "StaleBrokerError";
	}
}

export class BrokerRenewalContentionError extends Error {
	constructor() {
		super(BROKER_RENEWAL_CONTENTION_MESSAGE);
		this.name = "BrokerRenewalContentionError";
	}
}

export function isStaleBrokerError(error: unknown): boolean {
	return error instanceof StaleBrokerError
		|| (error instanceof Error && error.message === STALE_BROKER_ERROR_MESSAGE);
}

export function isBrokerRenewalContentionError(error: unknown): boolean {
	return error instanceof BrokerRenewalContentionError
		|| (error instanceof Error && error.message === BROKER_RENEWAL_CONTENTION_MESSAGE);
}

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

function isFileExistsError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function validateLeaseArtifact(value: BrokerLease | undefined, path: string): BrokerLease | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	if (value.schemaVersion !== 1) invalidDurableJson(path, "schemaVersion must be 1");
	if (typeof value.ownerId !== "string") invalidDurableJson(path, "ownerId must be a string");
	if (typeof value.pid !== "number" || !Number.isFinite(value.pid)) invalidDurableJson(path, "pid must be a finite number");
	if (typeof value.startedAtMs !== "number" || !Number.isFinite(value.startedAtMs)) invalidDurableJson(path, "startedAtMs must be a finite number");
	if (typeof value.leaseEpoch !== "number" || !Number.isFinite(value.leaseEpoch)) invalidDurableJson(path, "leaseEpoch must be a finite number");
	if (typeof value.socketPath !== "string") invalidDurableJson(path, "socketPath must be a string");
	if (typeof value.leaseUntilMs !== "number" || !Number.isFinite(value.leaseUntilMs)) invalidDurableJson(path, "leaseUntilMs must be a finite number");
	if (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs)) invalidDurableJson(path, "updatedAtMs must be a finite number");
	if (value.botId !== undefined && (typeof value.botId !== "number" || !Number.isFinite(value.botId))) invalidDurableJson(path, "botId must be a finite number when present");
	return value as BrokerLease;
}

function validateTakeoverLockArtifact(value: unknown, path: string): { pid?: number; updatedAtMs?: number } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	if (value.pid !== undefined && (typeof value.pid !== "number" || !Number.isFinite(value.pid))) invalidDurableJson(path, "pid must be a finite number when present");
	if (value.updatedAtMs !== undefined && (typeof value.updatedAtMs !== "number" || !Number.isFinite(value.updatedAtMs))) invalidDurableJson(path, "updatedAtMs must be a finite number when present");
	if (value.pid === undefined && value.updatedAtMs === undefined) invalidDurableJson(path, "pid or updatedAtMs must be present");
	return { pid: value.pid, updatedAtMs: value.updatedAtMs };
}

async function acquireTakeoverLock(ownerId: string, purpose?: "renew"): Promise<boolean> {
	try {
		await mkdir(TAKEOVER_LOCK_DIR);
		await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now(), ...(purpose ? { [purpose]: true } : {}) });
		return true;
	} catch (error) {
		if (!isFileExistsError(error)) throw error;
		const takeoverLockPath = join(TAKEOVER_LOCK_DIR, "lock.json");
		const takeover = validateTakeoverLockArtifact(await readJson<unknown>(takeoverLockPath), takeoverLockPath);
		const takeoverStats = await stat(TAKEOVER_LOCK_DIR).catch(() => undefined);
		const staleEmptyTakeover = !takeover && takeoverStats && now() - takeoverStats.mtimeMs > BROKER_LEASE_MS;
		const staleOwnedTakeover = takeover && ((takeover.pid && !processExists(takeover.pid)) || (takeover.updatedAtMs && now() - takeover.updatedAtMs > BROKER_LEASE_MS));
		if (!staleEmptyTakeover && !staleOwnedTakeover) return false;
		await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
		try {
			await mkdir(TAKEOVER_LOCK_DIR);
			await writeJson(join(TAKEOVER_LOCK_DIR, "lock.json"), { ownerId, pid: process.pid, updatedAtMs: now(), ...(purpose ? { [purpose]: true } : {}) });
			return true;
		} catch (retryError) {
			if (isFileExistsError(retryError)) return false;
			throw retryError;
		}
	}
}

export async function tryAcquireBrokerLease(deps: BrokerLeaseDeps): Promise<boolean> {
	const existing = validateLeaseArtifact(await deps.readLease(), LOCK_PATH);
	if (await deps.isLeaseLive(existing)) return false;
	if (!(await acquireTakeoverLock(deps.ownerId))) return false;
	try {
		const current = validateLeaseArtifact(await deps.readLease(), LOCK_PATH);
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
		locked = await acquireTakeoverLock(deps.ownerId, "renew");
		const lease = validateLeaseArtifact(await deps.readLease(), LOCK_PATH);
		if (!lease || lease.ownerId !== deps.ownerId || lease.leaseEpoch !== deps.getBrokerLeaseEpoch() || lease.leaseUntilMs <= now()) {
			await deps.stopBroker();
			return;
		}
		if (!locked) throw new BrokerRenewalContentionError();
		lease.leaseUntilMs = now() + BROKER_LEASE_MS;
		lease.updatedAtMs = now();
		await writeJson(LOCK_PATH, lease);
	} finally {
		if (locked) await rm(TAKEOVER_LOCK_DIR, { recursive: true, force: true }).catch(() => undefined);
	}
}
