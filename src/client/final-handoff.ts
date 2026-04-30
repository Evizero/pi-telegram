import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BROKER_DIR } from "../shared/paths.js";
import type { BrokerLease, BrokerState, TelegramRoute } from "../broker/types.js";
import type { AssistantFinalPayload, PendingTelegramTurn } from "./types.js";
import { ensurePrivateDir, invalidDurableJson, isRecord, now, readJson, writeJson } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api-errors.js";
import { AssistantFinalRetryQueue } from "./final-delivery.js";

export interface ClientAssistantFinalHandoffDeps {
	getSessionId: () => string;
	getConnectionNonce: () => string;
	getConnectionStartedAtMs: () => number;
	getConnectedRoute: () => TelegramRoute | undefined;
	isTurnDisconnected: (turnId: string) => boolean;
	peekDeferredPayload: () => AssistantFinalPayload | undefined;
	getBrokerState: () => BrokerState | undefined;
	acceptBrokerFinal: (payload: AssistantFinalPayload) => Promise<unknown>;
	postAssistantFinal: (payload: AssistantFinalPayload) => Promise<void>;
	postRestoreDeferredFinal: (clientSocketPath: string, targetSessionId: string, payload: AssistantFinalPayload) => Promise<void>;
	readLease: () => Promise<BrokerLease | undefined>;
	isLeaseLive: (lease: BrokerLease | undefined) => Promise<boolean>;
	setConnectedBrokerSocketPath: (socketPath: string) => void;
	isStaleSessionConnectionError: (error: unknown) => boolean;
	getAwaitingTelegramFinalTurnId: () => string | undefined;
	clearAwaitingTelegramFinalTurn: (turnId: string) => void;
	getActiveTelegramTurn: () => PendingTelegramTurn | undefined;
	setActiveTelegramTurn: (turn: PendingTelegramTurn | undefined) => void;
	rememberCompletedLocalTurn: (turnId: string) => void;
	startNextTelegramTurn: () => void;
	reportInvalidDurableState?: (path: string, error: unknown) => void;
}

interface PersistedClientFinals {
	schemaVersion?: number;
	sessionId?: string;
	connectionNonce?: string;
	connectionStartedAtMs?: number;
	payloads?: AssistantFinalPayload[];
	deferredPayloads?: AssistantFinalPayload[];
}

function optionalString(path: string, value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") invalidDurableJson(path, `${field} must be a string when present`);
	return value;
}

function finiteNumber(path: string, value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) invalidDurableJson(path, `${field} must be a finite number`);
	return value;
}

function optionalFiniteNumber(path: string, value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	return finiteNumber(path, value, field);
}

function validateQueuedAttachment(path: string, value: unknown, field: string): AssistantFinalPayload["attachments"][number] {
	if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
	if (typeof value.path !== "string") invalidDurableJson(path, `${field}.path must be a string`);
	if (typeof value.fileName !== "string") invalidDurableJson(path, `${field}.fileName must be a string`);
	return { path: value.path, fileName: value.fileName };
}

function validateTurn(path: string, value: unknown, field: string): PendingTelegramTurn {
	if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
	if (typeof value.turnId !== "string") invalidDurableJson(path, `${field}.turnId must be a string`);
	if (typeof value.sessionId !== "string") invalidDurableJson(path, `${field}.sessionId must be a string`);
	if (value.routeId !== undefined && typeof value.routeId !== "string") invalidDurableJson(path, `${field}.routeId must be a string when present`);
	if (typeof value.chatId !== "number" && typeof value.chatId !== "string") invalidDurableJson(path, `${field}.chatId must be a number or string`);
	if (typeof value.chatId === "number" && !Number.isFinite(value.chatId)) invalidDurableJson(path, `${field}.chatId must be finite when numeric`);
	if (value.messageThreadId !== undefined && (typeof value.messageThreadId !== "number" || !Number.isFinite(value.messageThreadId))) invalidDurableJson(path, `${field}.messageThreadId must be a finite number when present`);
	const replyToMessageId = finiteNumber(path, value.replyToMessageId, `${field}.replyToMessageId`);
	if (!Array.isArray(value.queuedAttachments)) invalidDurableJson(path, `${field}.queuedAttachments must be an array`);
	if (!Array.isArray(value.content)) invalidDurableJson(path, `${field}.content must be an array`);
	if (typeof value.historyText !== "string") invalidDurableJson(path, `${field}.historyText must be a string`);
	if (value.deliveryMode !== undefined && value.deliveryMode !== "steer" && value.deliveryMode !== "followUp") invalidDurableJson(path, `${field}.deliveryMode must be steer or followUp when present`);
	if (value.blockedByManualCompactionOperationId !== undefined && typeof value.blockedByManualCompactionOperationId !== "string") invalidDurableJson(path, `${field}.blockedByManualCompactionOperationId must be a string when present`);
	return {
		turnId: value.turnId,
		sessionId: value.sessionId,
		routeId: value.routeId,
		chatId: value.chatId,
		messageThreadId: value.messageThreadId,
		replyToMessageId,
		queuedAttachments: value.queuedAttachments.map((attachment, index) => validateQueuedAttachment(path, attachment, `${field}.queuedAttachments[${index}]`)),
		content: value.content as PendingTelegramTurn["content"],
		historyText: value.historyText,
		deliveryMode: value.deliveryMode,
		blockedByManualCompactionOperationId: value.blockedByManualCompactionOperationId,
	};
}

function validateAssistantFinalPayload(path: string, value: unknown, field: string): AssistantFinalPayload {
	if (!isRecord(value)) invalidDurableJson(path, `${field} must be an object`);
	const turn = validateTurn(path, value.turn, `${field}.turn`);
	const text = optionalString(path, value.text, `${field}.text`);
	const stopReason = optionalString(path, value.stopReason, `${field}.stopReason`);
	const errorMessage = optionalString(path, value.errorMessage, `${field}.errorMessage`);
	if (!Array.isArray(value.attachments)) invalidDurableJson(path, `${field}.attachments must be an array`);
	return { turn, text, stopReason, errorMessage, attachments: value.attachments.map((attachment, index) => validateQueuedAttachment(path, attachment, `${field}.attachments[${index}]`)) };
}

function validatePayloadArray(path: string, value: unknown, field: string): AssistantFinalPayload[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) invalidDurableJson(path, `${field} must be an array when present`);
	return value.map((payload, index) => validateAssistantFinalPayload(path, payload, `${field}[${index}]`));
}

function validatePersistedClientFinals(path: string, value: unknown): PersistedClientFinals | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	if (value.schemaVersion !== undefined && value.schemaVersion !== 2) invalidDurableJson(path, "schemaVersion must be 2 when present");
	if (typeof value.sessionId !== "string") invalidDurableJson(path, "sessionId must be a string");
	if (typeof value.connectionNonce !== "string") invalidDurableJson(path, "connectionNonce must be a string");
	const connectionStartedAtMs = finiteNumber(path, value.connectionStartedAtMs, "connectionStartedAtMs");
	return {
		schemaVersion: 2,
		sessionId: value.sessionId,
		connectionNonce: value.connectionNonce,
		connectionStartedAtMs,
		payloads: validatePayloadArray(path, value.payloads, "payloads"),
		deferredPayloads: validatePayloadArray(path, value.deferredPayloads, "deferredPayloads"),
	};
}

export class ClientAssistantFinalHandoff {
	private readonly queue = new AssistantFinalRetryQueue();
	private readonly diskOnlyPayloads = new Map<string, AssistantFinalPayload>();
	private persistedDeferredPayload: AssistantFinalPayload | undefined;

	constructor(private readonly deps: ClientAssistantFinalHandoffDeps) {}

	pendingFinalsDir(): string {
		return join(BROKER_DIR, "client-pending-finals");
	}

	find(turnId: string): AssistantFinalPayload | undefined {
		return this.queue.find(turnId);
	}

	deferNewFinals(): boolean {
		return this.queue.deferNewFinals();
	}

	clearQueue(): void {
		this.queue.clear();
	}

	setPersistedDeferredPayload(payload: AssistantFinalPayload | undefined): void {
		this.persistedDeferredPayload = payload;
	}

	clearPersistedDeferredPayload(): void {
		this.persistedDeferredPayload = undefined;
	}

	async enqueueAbortedFinal(turn: PendingTelegramTurn): Promise<void> {
		this.queue.enqueue({ turn, stopReason: "aborted", attachments: [] });
		await this.persistPending(turn.sessionId);
	}

	async prepareForHandoff(payload: AssistantFinalPayload): Promise<void> {
		this.diskOnlyPayloads.delete(payload.turn.turnId);
		this.queue.replacePending(payload);
		await this.persistPending(payload.turn.sessionId);
	}

	async persistDeferredState(targetSessionId = this.deps.getSessionId()): Promise<void> {
		await this.persistPending(targetSessionId);
	}

	async persistRestoredDeferredStateWhileBrokerHoldsLock(targetSessionId = this.deps.getSessionId()): Promise<void> {
		await ensurePrivateDir(this.pendingFinalsDir());
		await this.persistPendingLocked(targetSessionId);
	}

	async persistPending(targetSessionId = this.deps.getSessionId()): Promise<void> {
		await ensurePrivateDir(this.pendingFinalsDir());
		await this.withPendingFinalsLock(() => this.persistPendingLocked(targetSessionId));
	}

	private async persistPendingLocked(targetSessionId: string): Promise<void> {
		const pendingPath = this.pendingFinalsPath(targetSessionId);
		const existing = validatePersistedClientFinals(pendingPath, await readJson<unknown>(pendingPath));
		const existingTurnIds = new Set([...(existing?.payloads ?? []), ...(existing?.deferredPayloads ?? [])].map((payload) => payload.turn.turnId));
		const deferredPayload = this.deps.peekDeferredPayload() ?? (this.persistedDeferredPayload?.turn.sessionId === targetSessionId ? this.persistedDeferredPayload : undefined);
		if (deferredPayload?.turn.sessionId === targetSessionId) {
			this.queue.markDelivered(deferredPayload.turn.turnId);
			this.diskOnlyPayloads.delete(deferredPayload.turn.turnId);
		}
		const queuedPayloads = this.queue.pendingPayloads().filter((payload) => payload.turn.sessionId === targetSessionId);
		const queuedTurnIds = new Set(queuedPayloads.map((payload) => payload.turn.turnId));
		const diskOnlyPayloads = [...this.diskOnlyPayloads.values()].filter((payload) => payload.turn.sessionId === targetSessionId && existingTurnIds.has(payload.turn.turnId) && !queuedTurnIds.has(payload.turn.turnId));
		for (const payload of this.diskOnlyPayloads.values()) if (payload.turn.sessionId === targetSessionId && !existingTurnIds.has(payload.turn.turnId)) this.diskOnlyPayloads.delete(payload.turn.turnId);
		const payloads = [...queuedPayloads, ...diskOnlyPayloads];
		const deferredPayloads = deferredPayload && deferredPayload.turn.sessionId === targetSessionId ? [deferredPayload] : [];
		if (payloads.length === 0 && deferredPayloads.length === 0) {
			await rm(pendingPath, { force: true }).catch(() => undefined);
			return;
		}
		await writeJson(pendingPath, {
			schemaVersion: 2,
			sessionId: targetSessionId,
			connectionNonce: this.deps.getConnectionNonce(),
			connectionStartedAtMs: this.deps.getConnectionStartedAtMs(),
			payloads,
			deferredPayloads,
		});
	}

	async processPendingClientFinalFiles(): Promise<void> {
		const state = this.deps.getBrokerState();
		if (!state) return;
		await ensurePrivateDir(this.pendingFinalsDir());
		await this.withPendingFinalsLock(async () => {
			const names = await readdir(this.pendingFinalsDir()).catch(() => [] as string[]);
			for (const name of names) {
				if (!name.endsWith(".json")) continue;
				await this.processPendingClientFinalFile(state, name);
			}
		});
	}

	async handoffConfirmed(payload: AssistantFinalPayload): Promise<boolean> {
		if (this.shouldTreatAsLocallyDelivered(payload)) return true;
		try {
			await this.deps.postAssistantFinal(payload);
			return true;
		} catch {
			return await this.retryWithLiveLease(payload);
		}
	}

	async send(payload: AssistantFinalPayload, fromRetryQueue = false): Promise<boolean> {
		if (this.shouldTreatAsLocallyDelivered(payload)) {
			if (this.queue.find(payload.turn.turnId)) {
				this.queue.markDelivered(payload.turn.turnId);
				this.diskOnlyPayloads.set(payload.turn.turnId, payload);
				await this.persistPending(payload.turn.sessionId);
				return true;
			}
			await this.markDeliveredAndPersist(payload.turn.turnId, payload.turn.sessionId);
			return true;
		}
		if (!fromRetryQueue && this.queue.deferNewFinals() && !this.queue.canAttemptOnlyPendingTurn(payload.turn.turnId)) {
			if (this.queue.find(payload.turn.turnId)) this.queue.replacePending(payload);
			else this.queue.enqueue(payload);
			await this.persistPending(payload.turn.sessionId);
			return false;
		}
		if (!fromRetryQueue) {
			this.queue.replacePending(payload);
			await this.persistPending(payload.turn.sessionId);
		}
		try {
			await this.deps.postAssistantFinal(payload);
			await this.markDeliveredAndPersist(payload.turn.turnId, payload.turn.sessionId);
			return true;
		} catch (error) {
			if (this.deps.isStaleSessionConnectionError(error)) {
				this.queue.replacePending(payload);
				await this.persistPending(payload.turn.sessionId);
				return false;
			}
			if (getTelegramRetryAfterMs(error) !== undefined) {
				this.queue.markRetryable(payload, error);
				await this.persistPending(payload.turn.sessionId);
				return false;
			}
			if (await this.retryWithLiveLeaseAndMarkDelivered(payload)) return true;
		}
		this.queue.markRetryable(payload);
		await this.persistPending(payload.turn.sessionId);
		return false;
	}

	async retryPending(): Promise<void> {
		while (true) {
			const pending = this.queue.beginReadyAttempt();
			if (!pending) return;
			const delivered = await this.send(pending, true);
			if (!delivered) return;
			this.releaseTurnAfterDeliveredHandoff(pending.turn.turnId);
		}
	}

	async handoffPendingForShutdown(): Promise<void> {
		for (const payload of this.queue.pendingPayloads()) {
			const delivered = await this.handoffConfirmed(payload);
			if (!delivered) throw new Error(`Could not durably hand off pending assistant final for ${payload.turn.turnId}`);
			await this.markDeliveredAndPersist(payload.turn.turnId, payload.turn.sessionId);
		}
	}

	private pendingFinalsPath(targetSessionId: string): string {
		return join(this.pendingFinalsDir(), `${targetSessionId}.json`);
	}

	private pendingFinalsLockDir(): string {
		return join(BROKER_DIR, "client-pending-finals.lock");
	}

	private async removeStalePendingFinalsLock(lockDir: string): Promise<void> {
		const ownerPath = join(lockDir, "owner");
		const heartbeatPath = join(lockDir, "heartbeat");
		const owner = await readFile(ownerPath, "utf8").catch(() => undefined);
		const lockStats = await stat(heartbeatPath).catch(() => stat(lockDir).catch(() => undefined));
		if (!lockStats || now() - lockStats.mtimeMs <= 30_000) return;
		const latestOwner = await readFile(ownerPath, "utf8").catch(() => undefined);
		const latestStats = await stat(heartbeatPath).catch(() => stat(lockDir).catch(() => undefined));
		if (owner !== latestOwner || !latestStats || now() - latestStats.mtimeMs <= 30_000) return;
		await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
	}

	private async removeOwnedPendingFinalsLock(lockDir: string, lockToken: string): Promise<void> {
		const owner = await readFile(join(lockDir, "owner"), "utf8").catch(() => undefined);
		if (owner === lockToken) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
	}

	private async withPendingFinalsLock<T>(operation: () => Promise<T>): Promise<T> {
		const lockDir = this.pendingFinalsLockDir();
		const lockToken = `${process.pid}:${Date.now()}:${Math.random()}`;
		for (let attempt = 0; ; attempt += 1) {
			try {
				await mkdir(lockDir);
				await writeFile(join(lockDir, "owner"), lockToken);
				break;
			} catch {
				await this.removeStalePendingFinalsLock(lockDir);
				if (attempt >= 1_600) throw new Error("Timed out waiting for client pending-final lock");
				await new Promise((resolveValue) => setTimeout(resolveValue, 25));
			}
		}
		const heartbeatPath = join(lockDir, "heartbeat");
		let lostLock = false;
		const writeHeartbeat = async () => {
			try {
				if ((await readFile(join(lockDir, "owner"), "utf8").catch(() => undefined)) !== lockToken) {
					lostLock = true;
					return;
				}
				await writeFile(heartbeatPath, lockToken);
				if ((await readFile(join(lockDir, "owner"), "utf8").catch(() => undefined)) !== lockToken) lostLock = true;
			} catch {
				lostLock = true;
			}
		};
		await writeHeartbeat();
		const heartbeat = setInterval(() => { void writeHeartbeat(); }, 5_000);
		try {
			const result = await operation();
			if (lostLock) throw new Error("Lost client pending-final lock");
			return result;
		} finally {
			clearInterval(heartbeat);
			await this.removeOwnedPendingFinalsLock(lockDir, lockToken);
		}
	}

	private filePath(name: string): string {
		return join(this.pendingFinalsDir(), name);
	}

	private shouldTreatAsLocallyDelivered(payload: AssistantFinalPayload): boolean {
		return this.deps.isTurnDisconnected(payload.turn.turnId) || !this.deps.getConnectedRoute();
	}

	private async markDeliveredAndPersist(turnId: string, sessionId: string): Promise<void> {
		this.queue.markDelivered(turnId);
		await this.persistPending(sessionId);
	}

	private async retryWithLiveLeaseAndMarkDelivered(payload: AssistantFinalPayload): Promise<boolean> {
		const delivered = await this.retryWithLiveLease(payload);
		if (!delivered) return false;
		await this.markDeliveredAndPersist(payload.turn.turnId, payload.turn.sessionId);
		return true;
	}

	private async retryWithLiveLease(payload: AssistantFinalPayload): Promise<boolean> {
		const lease = await this.deps.readLease();
		if (!(await this.deps.isLeaseLive(lease)) || !lease) return false;
		this.deps.setConnectedBrokerSocketPath(lease.socketPath);
		try {
			await this.deps.postAssistantFinal(payload);
			return true;
		} catch (retryError) {
			if (this.deps.isStaleSessionConnectionError(retryError)) {
				this.queue.replacePending(payload);
				await this.persistPending(payload.turn.sessionId);
				return false;
			}
			this.queue.markRetryable(payload, retryError);
			await this.persistPending(payload.turn.sessionId);
			return false;
		}
	}

	private releaseTurnAfterDeliveredHandoff(turnId: string): void {
		if (this.deps.getAwaitingTelegramFinalTurnId() === turnId) {
			this.deps.rememberCompletedLocalTurn(turnId);
			this.deps.clearAwaitingTelegramFinalTurn(turnId);
			if (this.deps.getActiveTelegramTurn()?.turnId === turnId) this.deps.setActiveTelegramTurn(undefined);
			if (!this.queue.deferNewFinals()) this.deps.startNextTelegramTurn();
			return;
		}
		if (this.deps.getActiveTelegramTurn()?.turnId === turnId) {
			this.deps.rememberCompletedLocalTurn(turnId);
			this.deps.setActiveTelegramTurn(undefined);
			if (!this.queue.deferNewFinals()) this.deps.startNextTelegramTurn();
		}
	}

	private async processPendingClientFinalFile(state: BrokerState, name: string): Promise<void> {
		const path = this.filePath(name);
		let persisted: PersistedClientFinals | undefined;
		try {
			persisted = validatePersistedClientFinals(path, await readJson<unknown>(path));
		} catch (error) {
			this.deps.reportInvalidDurableState?.(path, error);
			return;
		}
		if (!persisted) return;
		const targetSessionId = persisted.sessionId;
		if (!targetSessionId) return;
		const payloads = persisted.payloads ?? [];
		const deferredPayloads = persisted.deferredPayloads ?? [];
		if (payloads.length === 0 && deferredPayloads.length === 0) {
			await rm(path, { force: true }).catch(() => undefined);
			return;
		}
		const currentSession = state.sessions[targetSessionId];
		if (currentSession && (currentSession.connectionNonce !== persisted.connectionNonce || currentSession.connectionStartedAtMs !== persisted.connectionStartedAtMs)) {
			const fenceMatches = currentSession.staleStandDownConnectionNonce === persisted.connectionNonce && currentSession.staleStandDownRequestedAtMs !== undefined;
			if (!fenceMatches) {
				await rm(path, { force: true }).catch(() => undefined);
				return;
			}
		}
		const rebuiltPayloads = this.rebuildPayloadsForBroker(state, targetSessionId, payloads);
		const rebuiltDeferredPayloads = this.rebuildPayloadsForBroker(state, targetSessionId, deferredPayloads);
		for (const payload of rebuiltPayloads) {
			await this.deps.acceptBrokerFinal(payload);
			this.diskOnlyPayloads.delete(payload.turn.turnId);
		}
		let restoredDeferredPayload = false;
		for (const payload of rebuiltDeferredPayloads) {
			const session = state.sessions[targetSessionId];
			if (!session) continue;
			try {
				await this.deps.postRestoreDeferredFinal(session.clientSocketPath, targetSessionId, payload);
				restoredDeferredPayload = true;
			} catch {
				await this.deps.acceptBrokerFinal(payload);
				this.diskOnlyPayloads.delete(payload.turn.turnId);
			}
		}
		if (rebuiltPayloads.length === 0 && rebuiltDeferredPayloads.length === 0) {
			await rm(path, { force: true }).catch(() => undefined);
			return;
		}
		if (restoredDeferredPayload) return;
		await rm(path, { force: true }).catch(() => undefined);
	}

	private rebuildPayloadsForBroker(state: BrokerState, targetSessionId: string, payloads: AssistantFinalPayload[]): AssistantFinalPayload[] {
		return payloads.flatMap((payload) => {
			const durableTurn = this.rebuildTurn(state, targetSessionId, payload);
			if (!durableTurn) return [];
			const preview = state.assistantPreviewMessages?.[payload.turn.turnId];
			if (preview && (String(preview.chatId) !== String(durableTurn.chatId) || preview.messageThreadId !== durableTurn.messageThreadId)) delete state.assistantPreviewMessages?.[payload.turn.turnId];
			return [{ ...payload, turn: durableTurn } satisfies AssistantFinalPayload];
		});
	}

	private rebuildTurn(state: BrokerState, targetSessionId: string, payload: AssistantFinalPayload): AssistantFinalPayload["turn"] | undefined {
		if (payload.turn.sessionId !== targetSessionId) return undefined;
		const durableTurn = state.pendingTurns?.[payload.turn.turnId]?.turn
			?? state.pendingAssistantFinals?.[payload.turn.turnId]?.turn
			?? (payload.turn.turnId.startsWith("local_") ? this.rebuildLocalTurnFromRoute(state, targetSessionId, payload.turn) : undefined);
		return durableTurn && durableTurn.sessionId === targetSessionId ? durableTurn : undefined;
	}

	private rebuildLocalTurnFromRoute(state: BrokerState, targetSessionId: string, turn: PendingTelegramTurn): PendingTelegramTurn | undefined {
		const sessionRoutes = Object.values(state.routes).filter((route) => route.sessionId === targetSessionId);
		const currentRoute = sessionRoutes.find((route) => route.routeId === turn.routeId)
			?? sessionRoutes.find((route) => route.chatId === turn.chatId && route.messageThreadId === turn.messageThreadId)
			?? (sessionRoutes.length === 1 ? sessionRoutes[0] : undefined);
		return currentRoute ? { ...turn, routeId: currentRoute.routeId, chatId: currentRoute.chatId, messageThreadId: currentRoute.messageThreadId } : turn;
	}
}
