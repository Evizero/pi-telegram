import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { createRuntimeUpdateHandlers } from "../src/broker/updates.js";
import { SESSION_OFFLINE_MS, SESSION_RECONNECT_GRACE_MS } from "../src/broker/policy.js";
import type { BrokerState } from "../src/broker/types.js";
import { session, state, topicRoute } from "./support/session-route-fixtures.js";
import { noopCommandRouter, testExtensionContext } from "./support/runtime-update-fixtures.js";


async function checkTopicSetupFailureRestoresRoutesAndQueuesNewOrphanCleanup(): Promise<void> {
	const oldRoute = topicRoute("session-1");
	const orphanRoute = { ...topicRoute("session-1"), routeId: "111:77", messageThreadId: 77 };
	const brokerState = state({ routes: { [oldRoute.routeId]: oldRoute }, pendingRouteCleanups: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {} });
	const replies: string[] = [];
	let persisted = 0;
	const handlers = createRuntimeUpdateHandlers({
		getConfig: () => ({ allowedUserId: 1, topicMode: "single_chat_selector", allowedChatId: 1 }),
		setConfig: () => undefined,
		getBrokerState: () => brokerState,
		setBrokerState: () => undefined,
		getBrokerLeaseEpoch: () => 1,
		getOwnerId: () => "owner",
		commandRouter: noopCommandRouter(() => brokerState),
		mediaGroups: new Map(),
		callTelegram: async <TResponse>() => [] as unknown as TResponse,
		writeConfig: async () => undefined,
		persistBrokerState: async () => { persisted += 1; },
		loadBrokerState: async () => brokerState,
		readLease: async () => undefined,
		stopBroker: async () => undefined,
		updateStatus: () => undefined,
		refreshTelegramStatus: () => undefined,
		sendTextReply: async (_chatId, _threadId, text) => { replies.push(text); return 1; },
		ensureRoutesAfterPairing: async () => {
			delete brokerState.routes[oldRoute.routeId];
			brokerState.routes[orphanRoute.routeId] = orphanRoute;
			throw new Error("topic create failed");
		},
		isAllowedTelegramChat: () => true,
		stopTypingLoop: () => undefined,
		dropAssistantPreviewState: async () => undefined,
		postIpc: async <TResponse>() => ({ ok: true } as TResponse),
		unregisterSession: async () => ({ ok: true }),
		markSessionOffline: async () => ({ ok: true }),
	});

	await handlers.handleUpdate({
		update_id: 1,
		message: {
			message_id: 1,
			chat: { id: 111, type: "supergroup", is_forum: true, title: "pi" },
			from: { id: 1, is_bot: false, first_name: "User" },
			text: "/topicsetup",
		},
	}, testExtensionContext());

	assert.deepEqual(brokerState.routes[oldRoute.routeId], oldRoute);
	assert.equal(brokerState.routes[orphanRoute.routeId], undefined);
	assert.deepEqual(brokerState.pendingRouteCleanups?.[orphanRoute.routeId]?.route, orphanRoute);
	assert.ok(replies.some((text) => /keeping the previous Telegram routing/i.test(text)));
	assert.ok(persisted >= 1);
}

async function checkOfflineMarkingUsesReconnectGraceBeforeCleanup(): Promise<void> {
	const freshSession = session({ sessionId: "fresh", lastHeartbeatMs: Date.now() - 5_000, status: "offline" });
	const reconnectingSession = session({ sessionId: "reconnecting", lastHeartbeatMs: Date.now() - SESSION_OFFLINE_MS - 1_000, status: "busy", activeTurnId: "active-turn" });
	const expiredSession = session({ sessionId: "expired", lastHeartbeatMs: Date.now() - SESSION_OFFLINE_MS - 1_000, status: "offline", reconnectGraceStartedAtMs: Date.now() - SESSION_RECONNECT_GRACE_MS - 1_000 });
	const freshRoute = { ...topicRoute("fresh"), routeId: "chat-1:11", messageThreadId: 11 };
	const reconnectingRoute = { ...topicRoute("reconnecting"), routeId: "chat-1:12", messageThreadId: 12 };
	const expiredRoute = { ...topicRoute("expired"), routeId: "chat-1:13", messageThreadId: 13 };
	const brokerState: BrokerState = {
		schemaVersion: 1,
		recentUpdateIds: [],
		sessions: { fresh: freshSession, reconnecting: reconnectingSession, expired: expiredSession },
		routes: {
			[freshRoute.routeId]: freshRoute,
			[reconnectingRoute.routeId]: reconnectingRoute,
			[expiredRoute.routeId]: expiredRoute,
		},
		pendingRouteCleanups: {},
		createdAtMs: Date.now(),
		updatedAtMs: Date.now(),
	};
	const expired: string[] = [];
	let persisted = 0;
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
		persistBrokerState: async () => { persisted += 1; },
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
		unregisterSession: async (targetSessionId: string) => { expired.push(`unregister:${targetSessionId}`); delete brokerState.sessions[targetSessionId]; for (const [routeId, route] of Object.entries(brokerState.routes)) if (route.sessionId === targetSessionId) delete brokerState.routes[routeId]; return { ok: true }; },
		markSessionOffline: async (targetSessionId: string) => { expired.push(targetSessionId); delete brokerState.sessions[targetSessionId]; for (const [routeId, route] of Object.entries(brokerState.routes)) if (route.sessionId === targetSessionId) delete brokerState.routes[routeId]; return { ok: true }; },
	});

	await handlers.markOfflineSessions();

	assert.deepEqual(expired, ["expired"]);
	assert.ok(brokerState.sessions.fresh);
	assert.ok(brokerState.sessions.reconnecting);
	assert.equal(brokerState.sessions.reconnecting.status, "offline");
	assert.equal(typeof brokerState.sessions.reconnecting.reconnectGraceStartedAtMs, "number");
	assert.ok(brokerState.routes[freshRoute.routeId]);
	assert.ok(brokerState.routes[reconnectingRoute.routeId]);
	assert.equal(brokerState.routes[expiredRoute.routeId], undefined);
	assert.ok(persisted >= 1);
}

await checkTopicSetupFailureRestoresRoutesAndQueuesNewOrphanCleanup();
await checkOfflineMarkingUsesReconnectGraceBeforeCleanup();
console.log("Session topic setup and offline grace checks passed");
