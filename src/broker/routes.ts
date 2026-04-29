import type { BrokerState, TelegramConfig, TelegramForumTopic, TelegramRoute, SessionRegistration } from "../shared/types.js";
import { routeId } from "../shared/format.js";
import { now } from "../shared/utils.js";

export interface EnsureRouteForSessionDeps {
	brokerState: BrokerState;
	registration: SessionRegistration;
	config: TelegramConfig;
	selectedChatId?: number | string;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
}

export function usesForumSupergroupRouting(config: TelegramConfig): boolean {
	return config.topicMode === "forum_supergroup" || ((config.topicMode ?? "auto") === "auto" && config.fallbackMode === "forum_supergroup");
}

export function targetChatIdForRoutes(config: TelegramConfig): number | string | undefined {
	return usesForumSupergroupRouting(config) ? config.fallbackSupergroupChatId : config.allowedChatId;
}

function queueRouteCleanup(brokerState: BrokerState, route: TelegramRoute): void {
	if (route.messageThreadId === undefined) return;
	brokerState.pendingRouteCleanups ??= {};
	brokerState.pendingRouteCleanups[route.routeId] = {
		route,
		createdAtMs: brokerState.pendingRouteCleanups[route.routeId]?.createdAtMs ?? now(),
		updatedAtMs: now(),
	};
}

function routesForSession(brokerState: BrokerState, sessionId: string): Array<[string, TelegramRoute]> {
	return Object.entries(brokerState.routes).filter(([, route]) => route.sessionId === sessionId);
}

function removePendingCleanupForActiveRoute(brokerState: BrokerState, route: TelegramRoute): void {
	for (const [cleanupId, cleanup] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (cleanup.route.routeId === route.routeId || (String(cleanup.route.chatId) === String(route.chatId) && cleanup.route.messageThreadId === route.messageThreadId)) delete brokerState.pendingRouteCleanups![cleanupId];
	}
}

function replaceRoutesForSession(brokerState: BrokerState, sessionId: string, route: TelegramRoute, routeKey: string): void {
	for (const [id, previousRoute] of routesForSession(brokerState, sessionId)) {
		if (id === routeKey || previousRoute.routeId === route.routeId) continue;
		queueRouteCleanup(brokerState, previousRoute);
		delete brokerState.routes[id];
	}
	brokerState.routes[routeKey] = route;
	removePendingCleanupForActiveRoute(brokerState, route);
}

export async function ensureRouteForSessionInBroker(deps: EnsureRouteForSessionDeps): Promise<TelegramRoute> {
	const { brokerState, registration, config, selectedChatId, sendTextReply, callTelegram } = deps;
	const existingRoutes = routesForSession(brokerState, registration.sessionId);
	const existing = existingRoutes.find(([, route]) => route.chatId !== 0)?.[1] ?? existingRoutes[0]?.[1];
	const expectedChatId = targetChatIdForRoutes(config);
	if (existing && existing.chatId !== 0) {
		if (expectedChatId !== undefined && String(existing.chatId) === String(expectedChatId)) {
			removePendingCleanupForActiveRoute(brokerState, existing);
			return existing;
		}
		if (existing.routeMode === "single_chat_selector" && selectedChatId !== undefined && String(existing.chatId) === String(selectedChatId)) {
			removePendingCleanupForActiveRoute(brokerState, existing);
			return existing;
		}
		if (expectedChatId === undefined && selectedChatId === undefined) {
			removePendingCleanupForActiveRoute(brokerState, existing);
			return existing;
		}
	}
	if (usesForumSupergroupRouting(config) && config.fallbackSupergroupChatId === undefined) {
		throw new Error("telegram.fallback_supergroup_chat_id is required for forum_supergroup fallback mode");
	}
	const targetChatId = targetChatIdForRoutes(config) ?? selectedChatId;
	if (!targetChatId) {
		return existing ?? {
			routeId: `pending:${registration.sessionId}`,
			sessionId: registration.sessionId,
			chatId: 0,
			routeMode: "single_chat_selector",
			topicName: registration.topicName,
			createdAtMs: now(),
			updatedAtMs: now(),
		};
	}
	let route: TelegramRoute;
	if ((config.topicMode ?? "auto") !== "single_chat_selector" && config.topicMode !== "disabled") {
		try {
			const topic = await callTelegram<TelegramForumTopic>("createForumTopic", { chat_id: targetChatId, name: registration.topicName });
			route = {
				routeId: routeId(targetChatId, topic.message_thread_id),
				sessionId: registration.sessionId,
				chatId: targetChatId,
				messageThreadId: topic.message_thread_id,
				routeMode: usesForumSupergroupRouting(config) ? "forum_supergroup_topic" : "private_topic",
				topicName: registration.topicName,
				createdAtMs: now(),
				updatedAtMs: now(),
			};
			replaceRoutesForSession(brokerState, registration.sessionId, route, route.routeId);
			await sendTextReply(route.chatId, route.messageThreadId, `Connected pi session: ${registration.topicName}`).catch(() => undefined);
			return route;
		} catch (error) {
			if (config.topicMode === "private_topics" || usesForumSupergroupRouting(config)) throw error;
			// Auto mode falls back to selector routing for this route only. Do not persistently downgrade config.
		}
	}
	if (config.topicMode === "disabled") throw new Error("Telegram routing is disabled by config");
	route = {
		routeId: routeId(targetChatId),
		sessionId: registration.sessionId,
		chatId: targetChatId,
		routeMode: "single_chat_selector",
		topicName: registration.topicName,
		createdAtMs: now(),
		updatedAtMs: now(),
	};
	const routeKey = `${route.routeId}:${registration.sessionId}`;
	replaceRoutesForSession(brokerState, registration.sessionId, route, routeKey);
	await sendTextReply(route.chatId, undefined, `Connected pi session: ${registration.topicName}\nUse /sessions and /use to select sessions.`);
	return route;
}
