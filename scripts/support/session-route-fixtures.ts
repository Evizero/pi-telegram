import { TelegramApiError } from "../../src/telegram/api.js";
import { BrokerSessionRegistrationCoordinator } from "../../src/broker/session-registration.js";
import { honorExplicitDisconnectRequestInBroker } from "../../src/broker/sessions.js";
import type { BrokerState, SessionRegistration, TelegramRoute } from "../../src/broker/types.js";
import type { PendingDisconnectRequest } from "../../src/broker/disconnect-requests.js";

export function session(overrides: Partial<SessionRegistration> = {}): SessionRegistration {
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

export function topicRoute(sessionId = "session-1"): TelegramRoute {
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

export function selectorRoute(sessionId = "session-1"): TelegramRoute {
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

export function state(overrides: Partial<BrokerState> = {}): BrokerState {
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

export async function honorScopedDisconnect(brokerState: BrokerState, request: PendingDisconnectRequest, stopped: string[] = []): Promise<{ honored: boolean }> {
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

export function registrationCoordinatorForCleanupCheck(brokerState: BrokerState, options: { honorPendingDisconnectRequest: (sessionId: string) => Promise<void>; created?: { count: number } }): BrokerSessionRegistrationCoordinator {
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

export {
	session as makeSession,
	topicRoute as makeTopicRoute,
	selectorRoute as makeSelectorRoute,
	state as makeBrokerState,
};
