import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { retryPendingRouteCleanupsInBroker, markSessionOfflineInBroker } from "../src/broker/sessions.js";
import { createRuntimeUpdateHandlers } from "../src/broker/updates.js";
import type { BrokerState, QueuedTurnControlState, SessionRegistration } from "../src/shared/types.js";
import { session, state, topicRoute } from "./support/session-route-fixtures.js";
import { noopCommandRouter } from "./support/runtime-update-fixtures.js";


async function checkMarkOfflinePreservesPendingWorkAndQueuesRouteCleanup(): Promise<void> {
	const queuedControl: QueuedTurnControlState = {
		token: "offline-control",
		turnId: "turn1",
		sessionId: "session-1",
		routeId: topicRoute().routeId,
		chatId: 111,
		messageThreadId: 9,
		statusMessageId: 74,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const retryPendingControl: QueuedTurnControlState = {
		token: "offline-retry-control",
		turnId: "turn-retry",
		sessionId: "session-1",
		routeId: topicRoute().routeId,
		chatId: 111,
		messageThreadId: 9,
		statusMessageId: 75,
		status: "cancelled",
		completedText: "Cancelled queued follow-up.",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const brokerState = state({
		queuedTurnControls: { [queuedControl.token]: queuedControl, [retryPendingControl.token]: retryPendingControl },
		pendingManualCompactions: {
			"compact-offline": { operationId: "compact-offline", sessionId: "session-1", routeId: topicRoute().routeId, chatId: 111, messageThreadId: 9, status: "queued", createdAtMs: Date.now(), updatedAtMs: Date.now() },
		},
	});
	brokerState.pendingTurns!.blockedByOfflineCompact = {
		turn: { turnId: "blockedByOfflineCompact", sessionId: "session-1", routeId: topicRoute().routeId, chatId: 111, messageThreadId: 9, replyToMessageId: 2, queuedAttachments: [], content: [], historyText: "after compact", blockedByManualCompactionOperationId: "compact-offline" },
		updatedAtMs: Date.now(),
	};
	const stopped: string[] = [];
	const cleanedTemps: string[] = [];
	const editCalls: Array<Record<string, unknown>> = [];
	let persisted = 0;
	await markSessionOfflineInBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => { persisted += 1; },
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: (turnId) => { stopped.push(turnId); },
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>) => {
			if (method === "editMessageText") {
				editCalls.push(body);
				return true as TResponse;
			}
			throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 3);
			return undefined as TResponse;
		},
		cleanupSessionTempDir: async (sessionId, currentBrokerState) => {
			cleanedTemps.push(sessionId);
			assert.equal(currentBrokerState.sessions[sessionId], undefined);
			assert.ok(currentBrokerState.pendingTurns?.turn1);
			assert.ok(currentBrokerState.pendingAssistantFinals?.turn2);
		},
	});

	assert.equal(brokerState.sessions["session-1"], undefined);
	assert.ok(brokerState.routes["chat-1:9"]);
	assert.ok(brokerState.pendingTurns?.turn1);
	assert.equal(brokerState.pendingTurns?.blockedByOfflineCompact, undefined);
	assert.equal(brokerState.pendingManualCompactions?.["compact-offline"], undefined);
	assert.ok(brokerState.pendingAssistantFinals?.turn2);
	assert.ok(brokerState.assistantPreviewMessages?.turn1);
	assert.ok(brokerState.assistantPreviewMessages?.turn2);
	assert.deepEqual(stopped.sort(), ["blockedByOfflineCompact", "turn1", "turn2"]);
	assert.equal(brokerState.pendingRouteCleanups?.["chat-1:9"], undefined);
	assert.equal(queuedControl.status, "expired");
	assert.equal(queuedControl.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof queuedControl.statusMessageFinalizedAtMs, "number");
	assert.equal(retryPendingControl.status, "cancelled");
	assert.equal(retryPendingControl.completedText, "Cancelled queued follow-up.");
	assert.equal(typeof retryPendingControl.statusMessageFinalizedAtMs, "number");
	assert.deepEqual(editCalls, [
		{ chat_id: 111, message_id: 74, text: "Queued follow-up was cleared." },
		{ chat_id: 111, message_id: 75, text: "Cancelled queued follow-up." },
	]);
	assert.ok(persisted >= 1);
	assert.deepEqual(cleanedTemps, ["session-1"]);
}

async function checkMarkOfflineClearsRouteWhenOnlyPendingTurnsRemain(): Promise<void> {
	const brokerState = state({
		pendingAssistantFinals: {},
		assistantPreviewMessages: { turn1: { chatId: 111, messageThreadId: 9, messageId: 50, updatedAtMs: Date.now() } },
	});
	const cleaned: Array<Record<string, unknown>> = [];
	await markSessionOfflineInBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram: async <TResponse>(_method: string, body: Record<string, unknown>) => {
			cleaned.push(body);
			return true as TResponse;
		},
	});

	assert.equal(brokerState.sessions["session-1"], undefined);
	assert.ok(brokerState.pendingTurns?.turn1);
	assert.equal(brokerState.routes["chat-1:9"], undefined);
	assert.equal(brokerState.assistantPreviewMessages?.turn1, undefined);
	assert.deepEqual(cleaned, [
		{ chat_id: 111, message_id: 50 },
		{ chat_id: 111, message_thread_id: 9 },
	]);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
}

async function checkRetryPendingTurnRehomesToCurrentRoute(): Promise<void> {
	const rehomeSession = session({ sessionId: "stale", clientSocketPath: "/tmp/stale.sock" });
	const brokerState = state({
		sessions: { [rehomeSession.sessionId]: rehomeSession },
		routes: { "chat-2:44": { routeId: "chat-2:44", sessionId: rehomeSession.sessionId, chatId: 222, messageThreadId: 44, routeMode: "forum_supergroup_topic", topicName: rehomeSession.topicName, createdAtMs: Date.now(), updatedAtMs: Date.now() } },
		pendingAssistantFinals: {},
		assistantPreviewMessages: { rehome: { chatId: 111, messageThreadId: 9, messageId: 60, updatedAtMs: Date.now() } },
		pendingTurns: {
			rehome: {
				turn: {
					turnId: "rehome",
					sessionId: rehomeSession.sessionId,
					chatId: 111,
					messageThreadId: 9,
					replyToMessageId: 1,
					queuedAttachments: [],
					content: [{ type: "text", text: "hello" }],
					historyText: "hello",
				},
				updatedAtMs: Date.now(),
			},
		},
	});
	const delivered: Array<{ chatId: number | string; messageThreadId?: number }> = [];
	const deletedPreviewBodies: Array<Record<string, unknown>> = [];
	const stoppedTurnIds: string[] = [];
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => brokerState),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>) => {
			if (method === "deleteMessage") deletedPreviewBodies.push(body);
			return [] as unknown as TResponse;
		},
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => brokerState,
		readLease: async () => undefined,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: (turnId) => { stoppedTurnIds.push(turnId); },
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "deliver_turn") {
				const turn = payload as { chatId: number | string; messageThreadId?: number };
				delivered.push({ chatId: turn.chatId, messageThreadId: turn.messageThreadId });
			}
			return { ok: true } as TResponse;
		},
		unregisterSession: async () => ({ ok: true }),
		markSessionOffline: async () => ({ ok: true }),
	});

	await handlers.retryPendingTurns();
	assert.deepEqual(deletedPreviewBodies, [{ chat_id: 111, message_id: 60 }]);
	assert.deepEqual(stoppedTurnIds, ["rehome"]);
	assert.deepEqual(delivered, [{ chatId: 222, messageThreadId: 44 }]);
	assert.equal(brokerState.pendingTurns?.rehome?.turn.chatId, 222);
	assert.equal(brokerState.pendingTurns?.rehome?.turn.messageThreadId, 44);
	assert.equal(brokerState.assistantPreviewMessages?.rehome, undefined);
}

async function checkRetryPendingTurnWaitsForBlockingManualCompaction(): Promise<void> {
	const brokerState = state({
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		pendingManualCompactions: {
			"compact-blocker": { operationId: "compact-blocker", sessionId: "session-1", routeId: topicRoute().routeId, chatId: 111, messageThreadId: 9, status: "queued", createdAtMs: Date.now(), updatedAtMs: Date.now() },
		},
		pendingTurns: {
			blocked: {
				turn: {
					turnId: "blocked",
					sessionId: "session-1",
					routeId: topicRoute().routeId,
					chatId: 111,
					messageThreadId: 9,
					replyToMessageId: 1,
					queuedAttachments: [],
					content: [{ type: "text", text: "after compact" }],
					historyText: "after compact",
					blockedByManualCompactionOperationId: "compact-blocker",
				},
				updatedAtMs: Date.now(),
			},
		},
	});
	const delivered: string[] = [];
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => brokerState),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>() => [] as unknown as TResponse,
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => brokerState,
		readLease: async () => undefined,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "deliver_turn") delivered.push((payload as { turnId: string }).turnId);
			return { ok: true } as TResponse;
		},
		unregisterSession: async () => ({ ok: true }),
		markSessionOffline: async () => ({ ok: true }),
	});

	await handlers.retryPendingTurns();
	assert.deepEqual(delivered, []);
	delete brokerState.pendingManualCompactions?.["compact-blocker"];
	await handlers.retryPendingTurns();
	assert.deepEqual(delivered, ["blocked"]);
}

async function checkRetryPendingTurnWaitsForPreviewDeleteBeforeRehome(): Promise<void> {
	const rehomeSession = session({ sessionId: "blocked", clientSocketPath: "/tmp/blocked.sock" });
	const brokerState = state({
		sessions: { [rehomeSession.sessionId]: rehomeSession },
		routes: { "chat-3:77": { routeId: "chat-3:77", sessionId: rehomeSession.sessionId, chatId: 333, messageThreadId: 77, routeMode: "forum_supergroup_topic", topicName: rehomeSession.topicName, createdAtMs: Date.now(), updatedAtMs: Date.now() } },
		pendingAssistantFinals: {},
		assistantPreviewMessages: { rehome: { chatId: 111, messageThreadId: 9, messageId: 61, updatedAtMs: Date.now() } },
		pendingTurns: {
			rehome: {
				turn: {
					turnId: "rehome",
					sessionId: rehomeSession.sessionId,
					chatId: 111,
					messageThreadId: 9,
					replyToMessageId: 1,
					queuedAttachments: [],
					content: [{ type: "text", text: "hello" }],
					historyText: "hello",
				},
				updatedAtMs: Date.now(),
			},
		},
	});
	const delivered: unknown[] = [];
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => brokerState),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>(method: string) => {
			if (method === "deleteMessage") throw new TelegramApiError(method, "Too Many Requests", 429, 2);
			return [] as unknown as TResponse;
		},
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => brokerState,
		readLease: async () => undefined,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "deliver_turn") delivered.push(payload);
			return { ok: true } as TResponse;
		},
		unregisterSession: async () => ({ ok: true }),
		markSessionOffline: async () => ({ ok: true }),
	});

	await handlers.retryPendingTurns();
	assert.deepEqual(delivered, []);
	assert.equal(brokerState.pendingTurns?.rehome?.turn.chatId, 111);
	assert.equal(brokerState.pendingTurns?.rehome?.turn.messageThreadId, 9);
	assert.ok(brokerState.assistantPreviewMessages?.rehome);
}

async function checkRetryPendingTurnDropsPreviewRefOnPermanentDeleteFailure(): Promise<void> {
	const rehomeSession = session({ sessionId: "permanent", clientSocketPath: "/tmp/permanent.sock" });
	const brokerState = state({
		sessions: { [rehomeSession.sessionId]: rehomeSession },
		routes: { "chat-4:88": { routeId: "chat-4:88", sessionId: rehomeSession.sessionId, chatId: 444, messageThreadId: 88, routeMode: "forum_supergroup_topic", topicName: rehomeSession.topicName, createdAtMs: Date.now(), updatedAtMs: Date.now() } },
		pendingAssistantFinals: {},
		assistantPreviewMessages: { rehome: { chatId: 111, messageThreadId: 9, messageId: 62, updatedAtMs: Date.now() } },
		pendingTurns: {
			rehome: {
				turn: {
					turnId: "rehome",
					sessionId: rehomeSession.sessionId,
					chatId: 111,
					messageThreadId: 9,
					replyToMessageId: 1,
					queuedAttachments: [],
					content: [{ type: "text", text: "hello" }],
					historyText: "hello",
				},
				updatedAtMs: Date.now(),
			},
		},
	});
	const delivered: Array<{ chatId: number | string; messageThreadId?: number }> = [];
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => brokerState),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>(method: string) => {
			if (method === "deleteMessage") throw new TelegramApiError(method, "Bad Request: message can't be deleted", 400, undefined);
			return [] as unknown as TResponse;
		},
		writeConfig: async () => undefined,
		persistBrokerState: async () => undefined,
		loadBrokerState: async () => brokerState,
		readLease: async () => undefined,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async () => undefined,
		ensureRoutesAfterPairing: async () => undefined,
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>(_socketPath: string, type: string, payload: unknown) => {
			if (type === "deliver_turn") {
				const turn = payload as { chatId: number | string; messageThreadId?: number };
				delivered.push({ chatId: turn.chatId, messageThreadId: turn.messageThreadId });
			}
			return { ok: true } as TResponse;
		},
		unregisterSession: async () => ({ ok: true }),
		markSessionOffline: async () => ({ ok: true }),
	});

	await handlers.retryPendingTurns();
	assert.deepEqual(delivered, [{ chatId: 444, messageThreadId: 88 }]);
	assert.equal(brokerState.assistantPreviewMessages?.rehome, undefined);
}

async function checkMarkOfflinePreservesPreviewRefWhenDeleteRetryableFails(): Promise<void> {
	const brokerState = state({
		pendingAssistantFinals: {},
		assistantPreviewMessages: { turn1: { chatId: 111, messageThreadId: 9, messageId: 50, updatedAtMs: Date.now() } },
	});
	await markSessionOfflineInBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram: async <TResponse>(method: string) => {
			if (method === "deleteMessage") throw new TelegramApiError(method, "Too Many Requests", 429, 2);
			return true as TResponse;
		},
	});

	assert.ok(brokerState.assistantPreviewMessages?.turn1);
}

await checkMarkOfflinePreservesPendingWorkAndQueuesRouteCleanup();
await checkMarkOfflineClearsRouteWhenOnlyPendingTurnsRemain();
await checkRetryPendingTurnRehomesToCurrentRoute();
await checkRetryPendingTurnWaitsForBlockingManualCompaction();
await checkRetryPendingTurnWaitsForPreviewDeleteBeforeRehome();
await checkRetryPendingTurnDropsPreviewRefOnPermanentDeleteFailure();
await checkMarkOfflinePreservesPreviewRefWhenDeleteRetryableFails();
console.log("Session pending turn rehome checks passed");
