import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { AssistantFinalRetryQueue } from "../src/client/final-delivery.js";
import { shutdownTelegramClientRoute } from "../src/client/route-shutdown.js";
import { processDisconnectRequestsInBroker } from "../src/broker/disconnect-requests.js";
import { ensureRouteForSessionInBroker } from "../src/broker/routes.js";
import { unregisterSessionFromBroker, retryPendingRouteCleanupsInBroker } from "../src/broker/sessions.js";
import { createRuntimeUpdateHandlers } from "../src/broker/updates.js";
import type { BrokerState, SessionRegistration, TelegramRoute } from "../src/shared/types.js";

function session(overrides: Partial<SessionRegistration> = {}): SessionRegistration {
	return {
		sessionId: "session-1",
		ownerId: "owner-1",
		pid: 123,
		cwd: "/tmp/project",
		projectName: "project",
		status: "idle",
		queuedTurnCount: 0,
		lastHeartbeatMs: Date.now(),
		connectedAtMs: Date.now(),
		clientSocketPath: "/tmp/client.sock",
		topicName: "project · main",
		...overrides,
	};
}

function topicRoute(sessionId = "session-1"): TelegramRoute {
	return {
		routeId: "chat-1:9",
		sessionId,
		chatId: 111,
		messageThreadId: 9,
		routeMode: "forum_supergroup_topic",
		topicName: "project · main",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function selectorRoute(sessionId = "session-1"): TelegramRoute {
	return {
		routeId: "chat-1",
		sessionId,
		chatId: 111,
		routeMode: "single_chat_selector",
		topicName: "project · main",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
}

function state(overrides: Partial<BrokerState> = {}): BrokerState {
	const currentSession = session();
	return {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { [currentSession.sessionId]: currentSession },
		routes: { [topicRoute().routeId]: topicRoute(), [`${selectorRoute().routeId}:${currentSession.sessionId}`]: selectorRoute() },
		pendingTurns: {
			turn1: {
				turn: {
					turnId: "turn1",
					sessionId: currentSession.sessionId,
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
		pendingAssistantFinals: {
			turn2: {
				status: "pending",
				createdAtMs: Date.now(),
				updatedAtMs: Date.now(),
				turn: {
					turnId: "turn2",
					sessionId: currentSession.sessionId,
					chatId: 111,
					messageThreadId: 9,
					replyToMessageId: 1,
					queuedAttachments: [],
					content: [{ type: "text", text: "final" }],
					historyText: "final",
				},
				attachments: [],
				progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] },
			},
		},
		pendingRouteCleanups: {},
		assistantPreviewMessages: {
			turn1: { chatId: 111, messageThreadId: 9, messageId: 50, updatedAtMs: Date.now() },
			turn2: { chatId: 111, messageThreadId: 9, messageId: 51, updatedAtMs: Date.now() },
		},
		selectorSelections: {
			"111": { chatId: 111, sessionId: currentSession.sessionId, expiresAtMs: Date.now() + 60_000, updatedAtMs: Date.now() },
		},
		completedTurnIds: [],
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		...overrides,
	};
}

async function checkUnregisterQueuesRetryableTopicCleanupAndDropsSessionState(): Promise<void> {
	const brokerState = state();
	const stopped: string[] = [];
	let persisted = 0;
	await unregisterSessionFromBroker({
		targetSessionId: "session-1",
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => { persisted += 1; },
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: (turnId) => { stopped.push(turnId); },
		callTelegram: async <TResponse>() => {
			throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 3);
			return undefined as TResponse;
		},
	});

	assert.equal(brokerState.sessions["session-1"], undefined);
	assert.deepEqual(Object.keys(brokerState.routes), []);
	assert.deepEqual(Object.keys(brokerState.selectorSelections ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.pendingTurns ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.pendingAssistantFinals ?? {}), []);
	assert.deepEqual(Object.keys(brokerState.assistantPreviewMessages ?? {}), []);
	assert.deepEqual(stopped.sort(), ["turn1", "turn2"]);
	assert.ok(brokerState.pendingRouteCleanups?.["chat-1:9"]);
	assert.ok((brokerState.pendingRouteCleanups?.["chat-1:9"]?.retryAtMs ?? 0) > Date.now());
	assert.ok(persisted >= 2);
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
	assert.equal(persisted, 1);
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

async function checkShutdownRouteClearsPendingFinalRetryQueue(): Promise<void> {
	const queue = new AssistantFinalRetryQueue();
	queue.enqueue({
		turn: {
			turnId: "turn-final",
			sessionId: "session-1",
			chatId: 111,
			messageThreadId: 9,
			replyToMessageId: 1,
			queuedAttachments: [],
			content: [{ type: "text", text: "final" }],
			historyText: "final",
		},
		text: "final",
		attachments: [],
	});
	let activeTurn: import("../src/shared/types.js").ActiveTelegramTurn | undefined = { turnId: "turn-active", sessionId: "session-1", chatId: 111, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "hello" }], historyText: "hello" };
	let connectedRoute: TelegramRoute | undefined = topicRoute();
	let queuedTurns: import("../src/shared/types.js").PendingTelegramTurn[] = [
		{ turnId: "turn-queued", sessionId: "session-1", chatId: 111, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "queued" }], historyText: "queued" },
	];
	shutdownTelegramClientRoute({
		setQueuedTelegramTurns: (turns) => { queuedTurns = turns; },
		setActiveTelegramTurn: (turn) => { activeTurn = turn; },
		setConnectedRoute: (route) => { connectedRoute = route; },
		assistantFinalQueue: queue,
	});

	assert.deepEqual(queuedTurns, []);
	assert.equal(activeTurn, undefined);
	assert.equal(connectedRoute, undefined);
	assert.equal(queue.find("turn-final"), undefined);
}

async function checkReconnectClearsPendingDisconnectRequestIntent(): Promise<void> {
	const currentSession = session({ lastHeartbeatMs: Date.now() });
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [topicRoute().routeId]: topicRoute() }, pendingRouteCleanups: {} });
	const unregistered: string[] = [];
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [
			{ sessionId: currentSession.sessionId, requestedAtMs: currentSession.lastHeartbeatMs - 1_000 },
			{ sessionId: currentSession.sessionId, requestedAtMs: currentSession.lastHeartbeatMs },
		],
		unregisterSession: async (sessionId) => { unregistered.push(sessionId); },
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.deepEqual(unregistered, []);
	assert.deepEqual(cleared, [currentSession.sessionId, currentSession.sessionId]);
}

async function checkReconnectWithinGraceReusesExistingRoute(): Promise<void> {
	const registration = session({ topicName: "project · main" });
	const existingRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [existingRoute.routeId]: existingRoute }, pendingRouteCleanups: {} });
	let created = 0;
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 111 },
		selectedChatId: undefined,
		sendTextReply: async () => undefined,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 99, name: "new" } as TResponse;
		},
	});

	assert.equal(route, existingRoute);
	assert.equal(created, 0);
	assert.equal(brokerState.routes[existingRoute.routeId], existingRoute);
}

async function checkRouteHomeChangeQueuesOldTopicCleanup(): Promise<void> {
	const registration = session({ topicName: "project · moved" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 222, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 222 },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => ({ message_thread_id: 44, name: registration.topicName } as TResponse),
	});

	assert.equal(route.chatId, 222);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	}

async function checkReconnectAfterCleanupCreatesFreshRoute(): Promise<void> {
	const registration = session({ sessionId: "session-2", topicName: "project · next" });
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [topicRoute(registration.sessionId).routeId]: { route: topicRoute(registration.sessionId), createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } } });
	const replies: Array<{ chatId: number | string; threadId?: number; text: string }> = [];
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 111 },
		selectedChatId: undefined,
		sendTextReply: async (chatId, threadId, text) => { replies.push({ chatId, threadId, text }); return 1; },
		callTelegram: async <TResponse>() => ({ message_thread_id: 33, name: registration.topicName } as TResponse),
	});

	assert.equal(route.messageThreadId, 33);
	assert.ok(brokerState.routes[route.routeId]);
	assert.equal(Object.keys(brokerState.routes).length, 1);
	assert.equal(replies.length, 1);
	assert.match(replies[0]?.text ?? "", /connected pi session/i);
}

async function checkOfflineMarkingUsesReconnectGraceBeforeCleanup(): Promise<void> {
	const freshSession = session({ sessionId: "fresh", lastHeartbeatMs: Date.now() - 5_000, status: "offline" });
	const staleSession = session({ sessionId: "stale", lastHeartbeatMs: Date.now() - 20_000, status: "busy" });
	const brokerState: BrokerState = {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { fresh: freshSession, stale: staleSession },
		routes: {
			[topicRoute("fresh").routeId]: topicRoute("fresh"),
			[topicRoute("stale").routeId]: topicRoute("stale"),
		},
		pendingRouteCleanups: {},
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
	const expired: string[] = [];
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: { dispatch: async () => undefined } as never,
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
		postIpc: async <TResponse>() => ({ ok: true } as TResponse),
		unregisterSession: async (targetSessionId: string) => { expired.push(targetSessionId); delete brokerState.sessions[targetSessionId]; return { ok: true }; },
	});

	await handlers.markOfflineSessions();

	assert.deepEqual(expired, ["stale"]);
	assert.ok(brokerState.sessions.fresh);
	assert.ok(brokerState.routes[topicRoute("fresh").routeId]);
}

await checkUnregisterQueuesRetryableTopicCleanupAndDropsSessionState();
await checkRetryPendingRouteCleanupCompletesAfterTransientFailure();
await checkAlreadyDeletedTopicCleanupIsIdempotent();
await checkTerminalAuthFailureIsSurfacedAndCleared();
await checkShutdownRouteClearsPendingFinalRetryQueue();
await checkReconnectClearsPendingDisconnectRequestIntent();
await checkReconnectWithinGraceReusesExistingRoute();
await checkRouteHomeChangeQueuesOldTopicCleanup();
await checkReconnectAfterCleanupCreatesFreshRoute();
await checkOfflineMarkingUsesReconnectGraceBeforeCleanup();
console.log("Session route cleanup checks passed");
