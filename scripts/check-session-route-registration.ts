import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { BrokerSessionRegistrationCoordinator } from "../src/broker/session-registration.js";
import { ensureRouteForSessionInBroker } from "../src/broker/routes.js";
import { retryPendingRouteCleanupsInBroker } from "../src/broker/sessions.js";
import type { PendingDisconnectRequest } from "../src/broker/disconnect-requests.js";
import type { QueuedTurnControlState, TelegramRoute } from "../src/broker/types.js";
import { honorScopedDisconnect, registrationCoordinatorForCleanupCheck, selectorRoute, session, state, topicRoute } from "./support/session-route-fixtures.js";


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

async function checkTopicRouteIsNotReusedForSelectorConfig(): Promise<void> {
	const registration = session({ topicName: "project · selector" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	let created = 0;
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "single_chat_selector", fallbackMode: "single_chat_selector" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 45, name: registration.topicName } as TResponse;
		},
	});

	assert.equal(created, 0);
	assert.equal(route.routeMode, "single_chat_selector");
	assert.equal(route.messageThreadId, undefined);
	assert.equal(String(route.chatId), "111");
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
	assert.equal(brokerState.routes[`${route.routeId}:${registration.sessionId}`], route);
}

async function checkExpectedSelectorReuseCleansStaleTopicRoute(): Promise<void> {
	const registration = session({ topicName: "project · selector reuse" });
	const staleTopic = topicRoute(registration.sessionId);
	const selector = selectorRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [staleTopic.routeId]: staleTopic, [`${selector.routeId}:${registration.sessionId}`]: selector }, pendingRouteCleanups: {} });
	let created = 0;
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "single_chat_selector", fallbackMode: "single_chat_selector" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 50, name: registration.topicName } as TResponse;
		},
	});

	assert.equal(created, 0);
	assert.equal(route, selector);
	assert.equal(brokerState.routes[staleTopic.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[staleTopic.routeId]);
	assert.equal(brokerState.routes[`${selector.routeId}:${registration.sessionId}`], selector);
}

async function checkSelectorRouteIsNotReusedForTopicConfig(): Promise<void> {
	const registration = session({ topicName: "project · topic" });
	const oldRoute = selectorRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [`${oldRoute.routeId}:${registration.sessionId}`]: oldRoute }, pendingRouteCleanups: {} });
	let created = 0;
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 111 },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 46, name: registration.topicName } as TResponse;
		},
	});

	assert.equal(created, 1);
	assert.equal(route.routeMode, "forum_supergroup_topic");
	assert.equal(route.messageThreadId, 46);
	assert.equal(brokerState.routes[`${oldRoute.routeId}:${registration.sessionId}`], undefined);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0, "selector routes do not have topics to clean up");
	assert.equal(brokerState.routes[route.routeId], route);
}

async function checkSelectorConfigWithoutTargetDetachesOldTopicRoute(): Promise<void> {
	const registration = session({ topicName: "project · no target" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { topicMode: "single_chat_selector", fallbackMode: "single_chat_selector" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => ({ message_thread_id: 48, name: registration.topicName } as TResponse),
	});

	assert.equal(route.routeId, `pending:${registration.sessionId}`);
	assert.equal(route.chatId, 0);
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
}

async function checkDisabledRoutingRejectsBeforeOldRouteReuse(): Promise<void> {
	const registration = session({ topicName: "project · disabled" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	let created = 0;
	await assert.rejects(() => ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "disabled", fallbackMode: "disabled" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 47, name: registration.topicName } as TResponse;
		},
	}), /routing is disabled/i);

	assert.equal(created, 0);
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
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

async function checkRouteCleanupRechecksActiveRouteAfterAwait(): Promise<void> {
	const cleanupRoute = topicRoute("session-1");
	const queuedControl: QueuedTurnControlState = {
		token: "late-active-control",
		turnId: "turn-late-active",
		sessionId: "session-1",
		routeId: cleanupRoute.routeId,
		chatId: cleanupRoute.chatId,
		messageThreadId: cleanupRoute.messageThreadId,
		statusMessageId: 80,
		status: "offered",
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
		expiresAtMs: Date.now() + 60_000,
	};
	const brokerState = state({
		sessions: {},
		routes: {},
		pendingRouteCleanups: { [cleanupRoute.routeId]: { route: cleanupRoute, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } },
		pendingTurns: {},
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		selectorSelections: {},
		queuedTurnControls: { [queuedControl.token]: queuedControl },
	});
	const calls: string[] = [];
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>(method: string) => {
			calls.push(method);
			if (method === "editMessageText") brokerState.routes[cleanupRoute.routeId] = cleanupRoute;
			return true as TResponse;
		},
	});

	assert.deepEqual(calls, ["editMessageText"]);
	assert.equal(brokerState.pendingRouteCleanups?.[cleanupRoute.routeId], undefined);
	assert.ok(brokerState.routes[cleanupRoute.routeId]);
}

async function checkRouteCleanupFencesTelegramDeletion(): Promise<void> {
	const cleanupRoute = topicRoute("offline-session");
	const brokerState = state({
		sessions: {},
		routes: {},
		pendingRouteCleanups: { [cleanupRoute.routeId]: { route: cleanupRoute, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } },
		pendingTurns: {},
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		selectorSelections: {},
	});
	const calls: string[] = [];
	await assert.rejects(() => retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		assertCanDeleteRoute: () => { throw new Error("stale_broker"); },
		callTelegram: async <TResponse>(method: string) => {
			calls.push(method);
			return true as TResponse;
		},
	}), /stale_broker/);

	assert.deepEqual(calls, []);
	assert.ok(brokerState.pendingRouteCleanups?.[cleanupRoute.routeId]);
}

async function checkRouteCleanupSkipsCurrentlyActiveRoute(): Promise<void> {
	const activeRoute = topicRoute("session-1");
	const brokerState = state({
		routes: { [activeRoute.routeId]: activeRoute },
		pendingRouteCleanups: { [activeRoute.routeId]: { route: { ...activeRoute }, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } },
		pendingTurns: {},
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		selectorSelections: {},
	});
	const calls: string[] = [];
	await retryPendingRouteCleanupsInBroker({
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>(method: string) => {
			calls.push(method);
			return true as TResponse;
		},
	});

	assert.deepEqual(calls, []);
	assert.ok(brokerState.routes[activeRoute.routeId]);
	assert.equal(brokerState.pendingRouteCleanups?.[activeRoute.routeId], undefined);
}

async function checkDisabledRoutingCleanupIsPersistedByRegistrationCoordinator(): Promise<void> {
	const registration = session({ topicName: "project · disabled-persist" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	let persisted = 0;
	let created = 0;
	const coordinator = new BrokerSessionRegistrationCoordinator({
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		loadBrokerState: async () => brokerState,
		persistBrokerState: async () => { persisted += 1; },
		getConfig: () => ({ allowedChatId: 111, topicMode: "disabled", fallbackMode: "disabled" }),
		selectedChatIdForSession: () => undefined,
		sendTextReply: async () => undefined,
		callTelegram: async <TResponse>() => {
			created += 1;
			return { message_thread_id: 49, name: registration.topicName } as TResponse;
		},
		postStaleClientConnection: () => undefined,
		honorPendingDisconnectRequest: async () => undefined,
		refreshTelegramStatus: () => undefined,
		retryPendingTurns: () => undefined,
		kickAssistantFinalLedger: () => undefined,
		createTelegramTurnForSession: async () => { throw new Error("not used"); },
		staleStandDownGraceMs: 1_000,
	});

	await assert.rejects(() => coordinator.registerSession(registration), /routing is disabled/i);
	assert.equal(created, 0);
	assert.equal(persisted, 1);
	assert.equal(brokerState.sessions[registration.sessionId], registration);
	assert.equal(brokerState.routes[oldRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[oldRoute.routeId]);
}

async function checkEnsureRoutesAfterPairingCleansAllDisabledRoutesBeforeRejecting(): Promise<void> {
	const first = session({ sessionId: "session-disabled-1", topicName: "project · one" });
	const second = session({ sessionId: "session-disabled-2", topicName: "project · two" });
	const firstRoute = { ...topicRoute(first.sessionId), routeId: "chat-1:51", messageThreadId: 51 };
	const secondRoute = { ...topicRoute(second.sessionId), routeId: "chat-1:52", messageThreadId: 52 };
	const brokerState = state({
		sessions: { [first.sessionId]: first, [second.sessionId]: second },
		routes: { [firstRoute.routeId]: firstRoute, [secondRoute.routeId]: secondRoute },
		pendingRouteCleanups: {},
		pendingTurns: {},
		pendingAssistantFinals: {},
		assistantPreviewMessages: {},
		selectorSelections: {},
	});
	let persisted = 0;
	const coordinator = new BrokerSessionRegistrationCoordinator({
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		loadBrokerState: async () => brokerState,
		persistBrokerState: async () => { persisted += 1; },
		getConfig: () => ({ allowedChatId: 111, topicMode: "disabled", fallbackMode: "disabled" }),
		selectedChatIdForSession: () => undefined,
		sendTextReply: async () => undefined,
		callTelegram: async <TResponse>() => ({ message_thread_id: 53, name: "unused" } as TResponse),
		postStaleClientConnection: () => undefined,
		honorPendingDisconnectRequest: async () => undefined,
		refreshTelegramStatus: () => undefined,
		retryPendingTurns: () => undefined,
		kickAssistantFinalLedger: () => undefined,
		createTelegramTurnForSession: async () => { throw new Error("not used"); },
		staleStandDownGraceMs: 1_000,
	});

	await assert.rejects(() => coordinator.ensureRoutesAfterPairing(), /routing is disabled/i);
	assert.ok(persisted >= 2);
	assert.equal(brokerState.routes[firstRoute.routeId], undefined);
	assert.equal(brokerState.routes[secondRoute.routeId], undefined);
	assert.ok(brokerState.pendingRouteCleanups?.[firstRoute.routeId]);
	assert.ok(brokerState.pendingRouteCleanups?.[secondRoute.routeId]);
	assert.equal(brokerState.sessions[first.sessionId], first);
	assert.equal(brokerState.sessions[second.sessionId], second);
}

async function checkAutoDisabledFallbackDoesNotCreateSelectorRoute(): Promise<void> {
	const registration = session({ topicName: "project · no fallback" });
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: {}, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {} });
	await assert.rejects(() => ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "auto", fallbackMode: "disabled" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async () => { throw new TelegramApiError("createForumTopic", "not enough rights", 403, undefined); },
	}), /not enough rights/i);

	assert.deepEqual(Object.keys(brokerState.routes), []);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
}

async function checkAutoRouteCreationFailureReusesExistingSelectorFallback(): Promise<void> {
	const registration = session({ topicName: "project · selector fallback" });
	const selector = selectorRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [`${selector.routeId}:${registration.sessionId}`]: selector }, pendingRouteCleanups: {} });
	let created = 0;
	const route = await ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "auto", fallbackMode: "single_chat_selector" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async () => {
			created += 1;
			throw new TelegramApiError("createForumTopic", "Too Many Requests", 429, 3);
		},
	});

	assert.equal(created, 0);
	assert.equal(route, selector);
	assert.equal(brokerState.routes[`${selector.routeId}:${registration.sessionId}`], selector);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
}

async function checkAutoRouteCreationFailurePreservesExistingRoute(): Promise<void> {
	const registration = session({ topicName: "project · auto-failed-move" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	await assert.rejects(() => ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 111, topicMode: "auto", fallbackMode: "single_chat_selector" },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async () => { throw new TelegramApiError("createForumTopic", "Too Many Requests", 429, 3); },
	}), /too many requests/i);

	assert.equal(brokerState.routes[oldRoute.routeId], oldRoute);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
}

async function checkRouteCreationFailurePreservesExistingRoute(): Promise<void> {
	const registration = session({ topicName: "project · failed-move" });
	const oldRoute = topicRoute(registration.sessionId);
	const brokerState = state({ sessions: { [registration.sessionId]: registration }, routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {} });
	await assert.rejects(() => ensureRouteForSessionInBroker({
		brokerState,
		registration,
		config: { allowedChatId: 222, topicMode: "forum_supergroup", fallbackMode: "forum_supergroup", fallbackSupergroupChatId: 222 },
		selectedChatId: undefined,
		sendTextReply: async () => 1,
		callTelegram: async () => { throw new TelegramApiError("createForumTopic", "not enough rights", 403, undefined); },
	}), /not enough rights/);

	assert.equal(brokerState.routes[oldRoute.routeId], oldRoute);
	assert.equal(Object.keys(brokerState.pendingRouteCleanups ?? {}).length, 0);
}

await checkReconnectWithinGraceReusesExistingRoute();
await checkRegistrationHonorsPendingDisconnectBeforeRouteReuse();
await checkStaleRegistrationCannotConsumeCurrentDisconnectRequest();
await checkRouteHomeChangeQueuesOldTopicCleanup();
await checkTopicRouteIsNotReusedForSelectorConfig();
await checkExpectedSelectorReuseCleansStaleTopicRoute();
await checkSelectorRouteIsNotReusedForTopicConfig();
await checkSelectorConfigWithoutTargetDetachesOldTopicRoute();
await checkDisabledRoutingRejectsBeforeOldRouteReuse();
await checkDisabledRoutingCleanupIsPersistedByRegistrationCoordinator();
await checkEnsureRoutesAfterPairingCleansAllDisabledRoutesBeforeRejecting();
await checkAutoDisabledFallbackDoesNotCreateSelectorRoute();
await checkAutoRouteCreationFailureReusesExistingSelectorFallback();
await checkAutoRouteCreationFailurePreservesExistingRoute();
await checkReconnectAfterCleanupCreatesFreshRoute();
await checkRouteCleanupRechecksActiveRouteAfterAwait();
await checkRouteCleanupFencesTelegramDeletion();
await checkRouteCleanupSkipsCurrentlyActiveRoute();
await checkRouteCreationFailurePreservesExistingRoute();
console.log("Session route registration checks passed");
