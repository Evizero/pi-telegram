import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TelegramApiError } from "../src/telegram/api.js";
import { AssistantFinalRetryQueue } from "../src/client/final-delivery.js";
import { shutdownTelegramClientRoute } from "../src/client/route-shutdown.js";
import { processDisconnectRequestsInBroker, readPendingDisconnectRequestsFromDir, type PendingDisconnectRequest } from "../src/broker/disconnect-requests.js";
import { honorExplicitDisconnectRequestInBroker } from "../src/broker/sessions.js";
import type { QueuedTurnControlState, TelegramRoute } from "../src/broker/types.js";
import { honorScopedDisconnect, selectorRoute, session, state, topicRoute } from "./support/session-route-fixtures.js";


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
	let activeTurn: import("../src/client/types.js").ActiveTelegramTurn | undefined = { turnId: "turn-active", sessionId: "session-1", chatId: 111, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "hello" }], historyText: "hello" };
	let connectedRoute: TelegramRoute | undefined = topicRoute();
	let queuedTurns: import("../src/client/types.js").PendingTelegramTurn[] = [
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
	const nowMs = Date.now();
	const currentSession = session({ connectionStartedAtMs: nowMs - 1, lastHeartbeatMs: nowMs });
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

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(() => true, () => false);
}

async function checkInvalidDisconnectRequestFilesDoNotBlockValidOnes(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-telegram-disconnect-"));
	try {
		const invalidPath = join(dir, "bad.json");
		const malformedPath = join(dir, "malformed.json");
		const validPath = join(dir, "session-1.json");
		await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, sessionId: "session-bad" }));
		await writeFile(malformedPath, "{not-json}\n");
		await writeFile(validPath, JSON.stringify({ schemaVersion: 1, sessionId: "session-1", requestedAtMs: 123 }));
		const invalidPaths: string[] = [];
		const requests = await readPendingDisconnectRequestsFromDir({ dir, onInvalidRequest: (path) => { invalidPaths.push(path); } });
		assert.deepEqual(requests, [{ sessionId: "session-1", requestedAtMs: 123, connectionNonce: undefined, connectionStartedAtMs: undefined, routeId: undefined, chatId: undefined, messageThreadId: undefined, routeCreatedAtMs: undefined }]);
		assert(invalidPaths.includes(invalidPath));
		assert(invalidPaths.includes(malformedPath));
		assert(await exists(invalidPath), "schema-invalid disconnect request should be preserved");
		assert(await exists(malformedPath), "malformed disconnect request should be preserved");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function checkCurrentRouteDisconnectOnlyCancelsTargetRouteFinals(): Promise<void> {
	const currentSession = session({ connectionNonce: "conn-current", connectionStartedAtMs: Date.now() - 2_000 });
	const targetRoute = { ...topicRoute(currentSession.sessionId), createdAtMs: Date.now() - 1_500 };
	const otherRoute: TelegramRoute = { routeId: "chat-2:44", sessionId: currentSession.sessionId, chatId: 222, messageThreadId: 44, routeMode: "forum_supergroup_topic", topicName: currentSession.topicName, createdAtMs: Date.now() - 1_400, updatedAtMs: Date.now() - 1_400 };
	const queuedControl: QueuedTurnControlState = {
		token: "route-control",
		turnId: "targetFinal",
		sessionId: currentSession.sessionId,
		routeId: targetRoute.routeId,
		chatId: targetRoute.chatId,
		messageThreadId: targetRoute.messageThreadId,
		statusMessageId: 71,
		status: "cancelling",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const otherQueuedControl: QueuedTurnControlState = {
		token: "other-route-control",
		turnId: "otherQueued",
		sessionId: currentSession.sessionId,
		routeId: otherRoute.routeId,
		chatId: otherRoute.chatId,
		messageThreadId: otherRoute.messageThreadId,
		statusMessageId: 72,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const brokerState = state({
		sessions: { [currentSession.sessionId]: currentSession },
		routes: { [targetRoute.routeId]: targetRoute, [otherRoute.routeId]: otherRoute },
		pendingRouteCleanups: {},
		pendingTurns: {},
		pendingAssistantFinals: {
			targetFinal: { status: "pending", createdAtMs: Date.now(), updatedAtMs: Date.now(), turn: { turnId: "targetFinal", sessionId: currentSession.sessionId, routeId: targetRoute.routeId, chatId: targetRoute.chatId, messageThreadId: targetRoute.messageThreadId, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "target" }], historyText: "target" }, attachments: [], progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } },
			otherFinal: { status: "pending", createdAtMs: Date.now(), updatedAtMs: Date.now(), turn: { turnId: "otherFinal", sessionId: currentSession.sessionId, routeId: otherRoute.routeId, chatId: otherRoute.chatId, messageThreadId: otherRoute.messageThreadId, replyToMessageId: 1, queuedAttachments: [], content: [{ type: "text", text: "other" }], historyText: "other" }, attachments: [], progress: { sentChunkIndexes: [], sentChunkMessageIds: {}, sentAttachmentIndexes: [] } },
		},
		queuedTurnControls: { [queuedControl.token]: queuedControl, [otherQueuedControl.token]: otherQueuedControl },
		assistantPreviewMessages: {},
	});
	const cancelled: Array<{ sessionId: string; turnIds?: string[] }> = [];
	const editCalls: Array<Record<string, unknown>> = [];
	await honorExplicitDisconnectRequestInBroker({
		targetSessionId: currentSession.sessionId,
		request: { sessionId: currentSession.sessionId, requestedAtMs: Date.now() - 1_000, connectionNonce: currentSession.connectionNonce, connectionStartedAtMs: currentSession.connectionStartedAtMs, routeId: targetRoute.routeId, chatId: targetRoute.chatId, messageThreadId: targetRoute.messageThreadId, routeCreatedAtMs: targetRoute.createdAtMs },
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		refreshTelegramStatus: () => undefined,
		stopTypingLoop: () => undefined,
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>) => {
			if (method === "editMessageText") {
				editCalls.push(body);
				return true as TResponse;
			}
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
	assert.equal(queuedControl.status, "expired");
	assert.equal(queuedControl.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof queuedControl.statusMessageFinalizedAtMs, "number");
	assert.equal(otherQueuedControl.status, "expired");
	assert.equal(otherQueuedControl.completedText, "Queued follow-up was cleared.");
	assert.equal(typeof otherQueuedControl.statusMessageFinalizedAtMs, "number");
	assert.deepEqual(editCalls, [
		{ chat_id: targetRoute.chatId, message_id: 71, text: "Queued follow-up was cleared." },
		{ chat_id: otherRoute.chatId, message_id: 72, text: "Queued follow-up was cleared." },
	]);
	assert.ok(brokerState.pendingRouteCleanups?.[targetRoute.routeId]);
}

await checkShutdownRouteClearsPendingFinalRetryQueue();
await checkShutdownRouteCanPreservePendingFinalRetryQueue();
await checkDisconnectRequestsWaitForPendingFinalsButOtherwiseUnregister();
await checkLateDisconnectRequestDoesNotDropOfflinePendingWork();
await checkStaleDisconnectRequestIsClearedAfterReconnect();
await checkRouteScopedDisconnectRequestRemovesOldRouteAfterReconnect();
await checkRouteScopedStaleRequestCannotDeleteNewSelectorRoute();
await checkInvalidDisconnectRequestFilesDoNotBlockValidOnes();
await checkCurrentRouteDisconnectOnlyCancelsTargetRouteFinals();
console.log("Session disconnect request checks passed");
