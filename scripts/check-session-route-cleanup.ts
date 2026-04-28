import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { AssistantFinalRetryQueue } from "../src/client/final-delivery.js";
import { shutdownTelegramClientRoute } from "../src/client/route-shutdown.js";
import { processDisconnectRequestsInBroker, type PendingDisconnectRequest } from "../src/broker/disconnect-requests.js";
import { ensureRouteForSessionInBroker } from "../src/broker/routes.js";
import { BrokerSessionRegistrationCoordinator } from "../src/broker/session-registration.js";
import { honorExplicitDisconnectRequestInBroker, unregisterSessionFromBroker, retryPendingRouteCleanupsInBroker, markSessionOfflineInBroker } from "../src/broker/sessions.js";
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
		connectionStartedAtMs: Date.now(),
		connectionNonce: "conn-1",
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
					routeId: topicRoute().routeId,
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
					routeId: topicRoute().routeId,
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

async function honorScopedDisconnect(brokerState: BrokerState, request: PendingDisconnectRequest, stopped: string[] = []): Promise<{ honored: boolean }> {
	const result = await honorExplicitDisconnectRequestInBroker({
		targetSessionId: request.sessionId,
		request,
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: (turnId) => { stopped.push(turnId); },
		callTelegram: async <TResponse>() => {
			throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 3);
			return true as TResponse;
		},
	});
	return { honored: result.honored };
}

async function checkUnregisterQueuesRetryableTopicCleanupAndDropsSessionState(): Promise<void> {
	const brokerState = state();
	const stopped: string[] = [];
	const cleanedTemps: string[] = [];
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
	assert.ok(brokerState.pendingRouteCleanups?.["chat-1:9"]);
	assert.ok((brokerState.pendingRouteCleanups?.["chat-1:9"]?.retryAtMs ?? 0) > Date.now());
	assert.ok(persisted >= 2);
	assert.deepEqual(cleanedTemps, ["session-1"]);
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
		clearAssistantFinalHandoff: () => queue.clear(),
	});

	assert.deepEqual(queuedTurns, []);
	assert.equal(activeTurn, undefined);
	assert.equal(connectedRoute, undefined);
	assert.equal(queue.find("turn-final"), undefined);
}

async function checkShutdownRouteCanPreservePendingFinalRetryQueue(): Promise<void> {
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
	shutdownTelegramClientRoute({
		setQueuedTelegramTurns: () => undefined,
		setActiveTelegramTurn: () => undefined,
		setConnectedRoute: () => undefined,
		clearAssistantFinalHandoff: () => queue.clear(),
		clearAssistantFinalQueue: false,
	});
	assert.ok(queue.find("turn-final"));
}

async function checkDisconnectRequestsWaitForPendingFinalsButOtherwiseUnregister(): Promise<void> {
	const currentSession = session({ lastHeartbeatMs: Date.now() });
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [topicRoute().routeId]: topicRoute() }, pendingAssistantFinals: {}, pendingRouteCleanups: {} });
	const unregistered: string[] = [];
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [{ sessionId: currentSession.sessionId, requestedAtMs: currentSession.lastHeartbeatMs, connectionNonce: currentSession.connectionNonce }],
		unregisterSession: async (sessionId) => { unregistered.push(sessionId); },
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.deepEqual(unregistered, [currentSession.sessionId]);
	assert.deepEqual(cleared, [currentSession.sessionId]);
}

async function checkLateDisconnectRequestDoesNotDropOfflinePendingWork(): Promise<void> {
	const brokerState = state({ sessions: {}, routes: {}, pendingRouteCleanups: {} });
	const unregistered: string[] = [];
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [{ sessionId: "session-1", requestedAtMs: Date.now() - 1_000, connectionNonce: "conn-1" }],
		unregisterSession: async (sessionId) => { unregistered.push(sessionId); },
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.deepEqual(unregistered, []);
	assert.deepEqual(cleared, ["session-1"]);
}

async function checkStaleDisconnectRequestIsClearedAfterReconnect(): Promise<void> {
	const currentSession = session({ connectionNonce: "conn-new" });
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [topicRoute().routeId]: topicRoute() }, pendingAssistantFinals: {}, pendingRouteCleanups: {} });
	const unregistered: string[] = [];
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [{ sessionId: currentSession.sessionId, requestedAtMs: Date.now() - 1_000, connectionNonce: "conn-old" }],
		unregisterSession: async (sessionId) => { unregistered.push(sessionId); },
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.deepEqual(unregistered, []);
	assert.deepEqual(cleared, [currentSession.sessionId]);
}

async function checkRouteScopedDisconnectRequestRemovesOldRouteAfterReconnect(): Promise<void> {
	const oldRoute = { ...topicRoute(), createdAtMs: Date.now() - 2_000 };
	const currentSession = session({ connectionNonce: "conn-new", connectionStartedAtMs: Date.now() });
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {} });
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [{ sessionId: currentSession.sessionId, requestedAtMs: Date.now() - 1_000, connectionNonce: "conn-old", connectionStartedAtMs: Date.now() - 3_000, routeId: oldRoute.routeId, chatId: oldRoute.chatId, messageThreadId: oldRoute.messageThreadId, routeCreatedAtMs: oldRoute.createdAtMs }],
		unregisterSession: async () => { throw new Error("route-scoped reconnect cleanup must not unregister the new connection"); },
		honorRouteScopedDisconnect: (request) => honorScopedDisconnect(brokerState, request),
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.ok(brokerState.sessions[currentSession.sessionId], "newer session registration must survive old route cleanup");
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
	assert.deepEqual(cleared, [currentSession.sessionId]);
}

async function checkRouteScopedStaleRequestCannotDeleteNewSelectorRoute(): Promise<void> {
	const requestedAtMs = Date.now() - 1_000;
	const oldRouteCreatedAtMs = requestedAtMs - 1_000;
	const newRoute = { ...selectorRoute(), createdAtMs: requestedAtMs };
	const currentSession = session({ connectionNonce: "conn-new", connectionStartedAtMs: Date.now() });
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [`${newRoute.routeId}:${currentSession.sessionId}`]: newRoute }, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {} });
	const cleared: string[] = [];
	await processDisconnectRequestsInBroker({
		brokerState,
		requests: [{ sessionId: currentSession.sessionId, requestedAtMs, connectionNonce: "conn-old", connectionStartedAtMs: requestedAtMs - 1_000, routeId: newRoute.routeId, chatId: newRoute.chatId, routeCreatedAtMs: oldRouteCreatedAtMs }],
		unregisterSession: async () => { throw new Error("stale route-scoped request must not unregister the new connection"); },
		honorRouteScopedDisconnect: (request) => honorScopedDisconnect(brokerState, request),
		clearRequest: async (sessionId) => { cleared.push(sessionId); },
	});

	assert.ok(brokerState.routes[`${newRoute.routeId}:${currentSession.sessionId}`], "new selector route with the same route id must survive when created after the request");
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
	assert.deepEqual(cleared, [currentSession.sessionId]);
}

async function checkCurrentRouteDisconnectOnlyCancelsTargetRouteFinals(): Promise<void> {
	const currentSession = session({ connectionNonce: "conn-current", connectionStartedAtMs: Date.now() - 2_000 });
	const targetRoute = { ...topicRoute(currentSession.sessionId), createdAtMs: Date.now() - 1_500 };
	const otherRoute: TelegramRoute = { routeId: "chat-2:44", sessionId: currentSession.sessionId, chatId: 222, messageThreadId: 44, routeMode: "forum_supergroup_topic", topicName: currentSession.topicName, createdAtMs: Date.now() - 1_400, updatedAtMs: Date.now() - 1_400 };
	const brokerState = state({
		sessions: { [currentSession.sessionId]: currentSession },
		routes: { [targetRoute.routeId]: targetRoute, [otherRoute.routeId]: otherRoute },
		pendingRouteCleanups: {},
		pendingTurns: {},
		pendingAssistantFinals: {
			targetFinal: { status: "pending", createdAtMs: Date.now(), updatedAtMs: Date.now(), turn: { turnId: "targetFinal", sessionId: currentSession.sessionId, routeId: targetRoute.routeId, chatId: targetRoute.chatId, messageThreadId: targetRoute.messageThreadId, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "target" }], historyText: "target" }, attachments: [], progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } },
			otherFinal: { status: "pending", createdAtMs: Date.now(), updatedAtMs: Date.now(), turn: { turnId: "otherFinal", sessionId: currentSession.sessionId, routeId: otherRoute.routeId, chatId: otherRoute.chatId, messageThreadId: otherRoute.messageThreadId, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "other" }], historyText: "other" }, attachments: [], progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } },
		},
		assistantPreviewMessages: {},
	});
	const cancelled: Array<{ sessionId: string; turnIds?: string[] }> = [];
	await honorExplicitDisconnectRequestInBroker({
		targetSessionId: currentSession.sessionId,
		request: { sessionId: currentSession.sessionId, requestedAtMs: Date.now() - 1_000, connectionNonce: currentSession.connectionNonce, connectionStartedAtMs: currentSession.connectionStartedAtMs, routeId: targetRoute.routeId, chatId: targetRoute.chatId, messageThreadId: targetRoute.messageThreadId, routeCreatedAtMs: targetRoute.createdAtMs },
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram: async <TResponse>() => {
			throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 3);
			return true as TResponse;
		},
		cancelPendingFinalDeliveries: async (sessionId, turnIds) => { cancelled.push({ sessionId, turnIds }); },
	});

	assert.equal(brokerState.sessions[currentSession.sessionId], undefined);
	assert.equal(brokerState.routes[targetRoute.routeId], undefined);
	assert.ok(brokerState.routes[otherRoute.routeId], "non-target route should remain for pending final cleanup");
	assert.equal(brokerState.pendingAssistantFinals?.targetFinal, undefined);
	assert.ok(brokerState.pendingAssistantFinals?.otherFinal, "non-target route final should remain pending");
	assert.deepEqual(cancelled, [{ sessionId: currentSession.sessionId, turnIds: ["targetFinal"] }]);
	assert.ok(brokerState.pendingRouteCleanups?.[targetRoute.routeId]);
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

function registrationCoordinatorForCleanupCheck(brokerState: BrokerState, options: { honorPendingDisconnectRequest: (sessionId: string) => Promise<void>; created?: { count: number } }): BrokerSessionRegistrationCoordinator {
	return new BrokerSessionRegistrationCoordinator({
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		loadBrokerState: async () => brokerState,
		persistBrokerState: async () => undefined,
		getConfig: () => ({ allowedChatId: 111, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 111 }),
		selectedChatIdForSession: () => undefined,
		sendTextReply: async () => undefined,
		callTelegram: async <TResponse>() => {
			if (options.created) options.created.count += 1;
			return { message_thread_id: 99, name: "fresh" } as TResponse;
		},
		postStaleClientConnection: () => undefined,
		honorPendingDisconnectRequest: options.honorPendingDisconnectRequest,
		refreshTelegramStatus: () => undefined,
		retryPendingTurns: () => undefined,
		kickAssistantFinalLedger: () => undefined,
		createTelegramTurnForSession: async () => { throw new Error("not used"); },
		staleStandDownGraceMs: 1_000,
	});
}

async function checkRegistrationHonorsPendingDisconnectBeforeRouteReuse(): Promise<void> {
	const oldSession = session({ connectionNonce: "conn-old", connectionStartedAtMs: Date.now() - 2_000 });
	const reconnectingSession = session({ connectionNonce: "conn-new", connectionStartedAtMs: Date.now(), topicName: "project · main" });
	const oldRoute = { ...topicRoute(oldSession.sessionId), createdAtMs: Date.now() - 3_000 };
	const disconnectRequest: PendingDisconnectRequest = { sessionId: oldSession.sessionId, requestedAtMs: Date.now() - 1_000, connectionNonce: oldSession.connectionNonce, connectionStartedAtMs: oldSession.connectionStartedAtMs, routeId: oldRoute.routeId, chatId: oldRoute.chatId, messageThreadId: oldRoute.messageThreadId, routeCreatedAtMs: oldRoute.createdAtMs };
	const brokerState = state({ sessions: { [oldSession.sessionId]: oldSession }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {} });
	const created = { count: 0 };
	let cleared = false;
	const coordinator = registrationCoordinatorForCleanupCheck(brokerState, {
		created,
		honorPendingDisconnectRequest: async () => {
			const result = await honorScopedDisconnect(brokerState, disconnectRequest);
			if (result.honored) cleared = true;
		},
	});

	const route = await coordinator.registerSession(reconnectingSession);

	assert.equal(cleared, true);
	assert.equal(created.count, 1);
	assert.equal(route.messageThreadId, 99);
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
	assert.ok(brokerState.routes[route.routeId]);
}

async function checkStaleRegistrationCannotConsumeCurrentDisconnectRequest(): Promise<void> {
	const currentSession = session({ connectionNonce: "conn-new", connectionStartedAtMs: Date.now() });
	const staleRegistration = session({ connectionNonce: "conn-old", connectionStartedAtMs: Date.now() - 5_000 });
	const currentRoute = { ...topicRoute(currentSession.sessionId), createdAtMs: Date.now() - 1_000 };
	const currentDisconnectRequest: PendingDisconnectRequest = { sessionId: currentSession.sessionId, requestedAtMs: Date.now(), connectionNonce: currentSession.connectionNonce, connectionStartedAtMs: currentSession.connectionStartedAtMs, routeId: currentRoute.routeId, chatId: currentRoute.chatId, messageThreadId: currentRoute.messageThreadId, routeCreatedAtMs: currentRoute.createdAtMs };
	const brokerState = state({ sessions: { [currentSession.sessionId]: currentSession }, routes: { [currentRoute.routeId]: currentRoute }, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {} });
	let honored = false;
	const coordinator = registrationCoordinatorForCleanupCheck(brokerState, {
		honorPendingDisconnectRequest: async () => {
			honored = true;
			await honorScopedDisconnect(brokerState, currentDisconnectRequest);
		},
	});

	await assert.rejects(() => coordinator.registerSession(staleRegistration), /stale_session_connection/);
	assert.equal(honored, false, "stale registrations must be rejected before pending disconnect requests are honored");
	assert.ok(brokerState.sessions[currentSession.sessionId]);
	assert.ok(brokerState.routes[currentRoute.routeId]);
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

async function checkMarkOfflinePreservesPendingWorkAndQueuesRouteCleanup(): Promise<void> {
	const brokerState = state();
	const stopped: string[] = [];
	const cleanedTemps: string[] = [];
	let persisted = 0;
	await markSessionOfflineInBroker({
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
	assert.ok(brokerState.pendingAssistantFinals?.turn2);
	assert.ok(brokerState.assistantPreviewMessages?.turn1);
	assert.ok(brokerState.assistantPreviewMessages?.turn2);
	assert.deepEqual(stopped.sort(), ["turn1", "turn2"]);
	assert.equal(brokerState.pendingRouteCleanups?.["chat-1:9"], undefined);
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
		commandRouter: { dispatch: async () => undefined } as never,
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
		commandRouter: { dispatch: async () => undefined } as never,
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
		commandRouter: { dispatch: async () => undefined } as never,
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
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>() => ({ ok: true } as TResponse),
		unregisterSession: async (targetSessionId: string) => { expired.push(`unregister:${targetSessionId}`); delete brokerState.sessions[targetSessionId]; return { ok: true }; },
		markSessionOffline: async (targetSessionId: string) => { expired.push(targetSessionId); delete brokerState.sessions[targetSessionId]; return { ok: true }; },
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
await checkShutdownRouteCanPreservePendingFinalRetryQueue();
await checkDisconnectRequestsWaitForPendingFinalsButOtherwiseUnregister();
await checkLateDisconnectRequestDoesNotDropOfflinePendingWork();
await checkStaleDisconnectRequestIsClearedAfterReconnect();
await checkRouteScopedDisconnectRequestRemovesOldRouteAfterReconnect();
await checkRouteScopedStaleRequestCannotDeleteNewSelectorRoute();
await checkCurrentRouteDisconnectOnlyCancelsTargetRouteFinals();
await checkReconnectWithinGraceReusesExistingRoute();
await checkRegistrationHonorsPendingDisconnectBeforeRouteReuse();
await checkStaleRegistrationCannotConsumeCurrentDisconnectRequest();
await checkRouteHomeChangeQueuesOldTopicCleanup();
await checkReconnectAfterCleanupCreatesFreshRoute();
await checkMarkOfflinePreservesPendingWorkAndQueuesRouteCleanup();
await checkMarkOfflineClearsRouteWhenOnlyPendingTurnsRemain();
await checkMarkOfflinePreservesPreviewRefWhenDeleteRetryableFails();
await checkRetryPendingTurnWaitsForPreviewDeleteBeforeRehome();
await checkRetryPendingTurnDropsPreviewRefOnPermanentDeleteFailure();
await checkRetryPendingTurnRehomesToCurrentRoute();
await checkOfflineMarkingUsesReconnectGraceBeforeCleanup();
console.log("Session route cleanup checks passed");
