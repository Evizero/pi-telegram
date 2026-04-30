import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { unregisterSessionFromBroker, retryPendingRouteCleanupsInBroker } from "../src/broker/sessions.js";
import type { QueuedTurnControlState } from "../src/shared/types.js";
import { session, state, topicRoute } from "./support/session-route-fixtures.js";


async function checkUnregisterQueuesRetryableTopicCleanupAndDropsSessionState(): Promise<void> {
	const brokerState = state();
	const queuedControl: QueuedTurnControlState = {
		token: "queued-control",
		turnId: "turn1",
		sessionId: "session-1",
		routeId: topicRoute().routeId,
		chatId: 111,
		messageThreadId: 9,
		statusMessageId: 70,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls = { [queuedControl.token]: queuedControl };
	const stopped: string[] = [];
	const cleanedTemps: string[] = [];
	const editCalls: Array<Record<string, unknown>> = [];
	let persisted = 0;
	await unregisterSessionFromBroker({
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
			assert.deepEqual(Object.keys(currentBrokerState.pendingTurns ?? {}), []);
			assert.deepEqual(Object.keys(currentBrokerState.pendingAssistantFinals ?? {}), []);
		},
	});

	assert.equal(brokerState.sessions["session-1"], undefined);
	assert.deepEqual(Object.keys(brokerState.routes), []);
	assert.deepEqual(Object.keys(brokerState.selectorSelections ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.pendingTurns ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.pendingAssistantFinals ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.assistantPreviewMessages ?? {}), []);
	assert.deepEqual(stopped.sort(), ["turn1", "turn2"]);
	assert.equal(queuedControl.status, "expired");
	assert.equal(queuedControl.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof queuedControl.statusMessageFinalizedAtMs, "number");
	assert.deepEqual(editCalls, [{ chat_id: 111, message_id: 70, text: "Queued follow-up was cleared." }]);
	assert.ok(brokerState.pendingRouteCleanups?.["chat-1:9"]);
	assert.ok((brokerState.pendingRouteCleanups?.["chat-1:9"]?.retryAtMs ?? 0) > Date.now());
	assert.ok(persisted >= 2);
	assert.deepEqual(cleanedTemps, ["session-1"]);
}

async function checkQueuedControlRetryAfterDefersTopicCleanup(): Promise<void> {
	const brokerState = state();
	const queuedControl: QueuedTurnControlState = {
		token: "retry-control",
		turnId: "turn1",
		sessionId: "session-1",
		routeId: topicRoute().routeId,
		chatId: 111,
		messageThreadId: 9,
		statusMessageId: 72,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	brokerState.queuedTurnControls = { [queuedControl.token]: queuedControl };
	const methods: string[] = [];
	let failQueuedControlEdit = true;
	const callTelegram = async <TResponse>(method: string): Promise<TResponse> => {
		methods.push(method);
		if (method === "editMessageText" && failQueuedControlEdit) {
			failQueuedControlEdit = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 3);
		}
		return true as TResponse;
	};
	await unregisterSessionFromBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram,
	});

	assert.equal(queuedControl.status, "expired");
	assert.equal(queuedControl.completedText, "Queued follow-up was cleared.");
	assert.equal(queuedControl.statusMessageFinalizedAtMs, undefined);
	assert.ok((queuedControl.statusMessageRetryAtMs ?? 0) > Date.now());
	assert.deepEqual(methods, ["editMessageText"]);
	assert.ok(brokerState.pendingRouteCleanups?.[topicRoute().routeId]);
	assert.ok((brokerState.pendingRouteCleanups?.[topicRoute().routeId]?.retryAtMs ?? 0) > Date.now());

	queuedControl.statusMessageRetryAtMs = Date.now() - 1;
	brokerState.queuedTurnControlCleanupRetryAtMs = Date.now() - 1;
	brokerState.telegramOutboxRetryAtMs = Date.now() - 1;
	brokerState.pendingRouteCleanups![topicRoute().routeId]!.retryAtMs = Date.now() - 1;
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram,
	});

	assert.deepEqual(methods, ["editMessageText", "editMessageText", "deleteForumTopic"]);
	assert.equal(typeof queuedControl.statusMessageFinalizedAtMs, "number");
	assert.deepEqual(Object.keys(brokerState.pendingRouteCleanups ?? {}), []);
}

async function checkRouteCleanupFinalizesUnmarkedQueuedControlsBeforeTopicDeletion(): Promise<void> {
	const route = topicRoute();
	const brokerState = state({
		sessions: {},
		routes: {},
		pendingTurns: {},
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		selectorSelections: {},
		pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000, retryAtMs: Date.now() - 1 } },
		queuedTurnControls: {
			unmarked: {
				token: "unmarked",
				turnId: "removed-turn",
				sessionId: route.sessionId,
				routeId: route.routeId,
				chatId: route.chatId,
				messageThreadId: route.messageThreadId,
				statusMessageId: 73,
				status: "offered",
				createdAtMs: Date.now(),
				updatedAtMs: Date.now(),
				expiresAtMs: Date.now() + 60_000,
			},
			legacy: {
				token: "legacy",
				turnId: "legacy-turn",
				sessionId: route.sessionId,
				routeId: route.routeId,
				chatId: route.chatId,
				messageThreadId: route.messageThreadId,
				statusMessageId: 74,
				status: "expired",
				createdAtMs: Date.now(),
				updatedAtMs: Date.now(),
				expiresAtMs: Date.now() + 60_000,
			},
		},
	});
	const methods: string[] = [];
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>(method: string) => {
			methods.push(method);
			return true as TResponse;
		},
	});

	const control = brokerState.queuedTurnControls!.unmarked!;
	const legacyControl = brokerState.queuedTurnControls!.legacy!;
	assert.equal(control.status, "expired");
	assert.equal(control.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof control.statusMessageFinalizedAtMs, "number");
	assert.equal(legacyControl.status, "expired");
	assert.equal(legacyControl.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof legacyControl.statusMessageFinalizedAtMs, "number");
	assert.deepEqual(methods, ["editMessageText", "editMessageText", "deleteForumTopic"]);
	assert.deepEqual(Object.keys(brokerState.pendingRouteCleanups ?? {}), []);
}

async function checkUnregisterDoesNotDeleteOtherPendingRouteBeforeControlsMarked(): Promise<void> {
	const otherRoute = { ...topicRoute("session-2"), routeId: "chat-1:10", messageThreadId: 10 };
	const otherControl: QueuedTurnControlState = {
		token: "other-control",
		turnId: "other-turn",
		sessionId: otherRoute.sessionId,
		routeId: otherRoute.routeId,
		chatId: otherRoute.chatId,
		messageThreadId: otherRoute.messageThreadId,
		statusMessageId: 90,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const brokerState = state({
		pendingRouteCleanups: { [otherRoute.routeId]: { route: otherRoute, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } },
		queuedTurnControls: { [otherControl.token]: otherControl },
	});
	const calls: Array<{ method: string; thread?: unknown; message?: unknown }> = [];
	await unregisterSessionFromBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>) => {
			calls.push({ method, thread: body.message_thread_id, message: body.message_id });
			return true as TResponse;
		},
	});

	const otherEditIndex = calls.findIndex((call) => call.method === "editMessageText" && call.message === 90);
	const otherDeleteIndex = calls.findIndex((call) => call.method === "deleteForumTopic" && call.thread === 10);
	assert.ok(otherEditIndex >= 0);
	assert.ok(otherDeleteIndex > otherEditIndex);
	assert.equal(otherControl.status, "expired");
	assert.equal(typeof otherControl.statusMessageFinalizedAtMs, "number");
}

async function checkRetryPendingRouteCleanupCompletesAfterTransientFailure(): Promise<void> {
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [topicRoute().routeId]: { route: topicRoute(), createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000, retryAtMs: Date.now() - 1 } } });
	const calls: Array<Record<string, unknown>> = [];
	let persisted = 0;
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => { persisted += 1; },
		callTelegram: async <TResponse>(_method: string, body: Record<string, unknown>) => {
			calls.push(body);
			return true as TResponse;
		},
	});

	assert.deepEqual(calls, [{ chat_id: 111, message_thread_id: 9 }]);
	assert.deepEqual(Object.keys(brokerState.pendingRouteCleanups ?? {}), []);
	assert.ok(persisted >= 1);
}

async function checkAlreadyDeletedTopicCleanupIsIdempotent(): Promise<void> {
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [topicRoute().routeId]: { route: topicRoute(), createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } } });
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>() => {
			throw new TelegramApiError("deleteForumTopic", "Bad Request: message thread not found", 400, undefined);
			return undefined as TResponse;
		},
	});

	assert.deepEqual(Object.keys(brokerState.pendingRouteCleanups ?? {}), []);
}

async function checkTerminalAuthFailureIsSurfacedAndCleared(): Promise<void> {
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [topicRoute().routeId]: { route: topicRoute(), createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } } });
	const terminalFailures: string[] = [];
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>() => {
			throw new TelegramApiError("deleteForumTopic", "Unauthorized", 401, undefined);
			return undefined as TResponse;
		},
		logTerminalCleanupFailure: (_route, reason) => { terminalFailures.push(reason); },
	});

	assert.deepEqual(Object.keys(brokerState.pendingRouteCleanups ?? {}), []);
	assert.equal(terminalFailures.length, 1);
	assert.match(terminalFailures[0] ?? "", /unauthorized/i);
}

await checkUnregisterQueuesRetryableTopicCleanupAndDropsSessionState();
await checkQueuedControlRetryAfterDefersTopicCleanup();
await checkRouteCleanupFinalizesUnmarkedQueuedControlsBeforeTopicDeletion();
await checkUnregisterDoesNotDeleteOtherPendingRouteBeforeControlsMarked();
await checkRetryPendingRouteCleanupCompletesAfterTransientFailure();
await checkAlreadyDeletedTopicCleanupIsIdempotent();
await checkTerminalAuthFailureIsSurfacedAndCleared();
console.log("Session unregister cleanup checks passed");
