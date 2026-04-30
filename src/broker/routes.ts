import type { BrokerState, SessionRegistration, TelegramConfig, TelegramForumTopic, TelegramRoute } from "../shared/types.js";
import { routeId } from "../shared/format.js";
import { canonicalRouteKey, routeMatchesTopicIdentity } from "../shared/routing.js";
import { now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";

export { canonicalRouteKey, routeBoundControlBelongsToRoute, routeMatchesTopicIdentity, retargetTurnToRoute, turnBelongsToRoute } from "../shared/routing.js";

export class TelegramRoutingDisabledError extends Error {
	constructor() {
		super("Telegram routing is disabled by config");
		this.name = "TelegramRoutingDisabledError";
	}
}

export interface EnsureRouteForSessionDeps {
	brokerState: BrokerState;
	registration: SessionRegistration;
	config: TelegramConfig;
	selectedChatId?: number | string;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
}

type ExpectedRouteTarget =
	| { kind: "disabled" }
	| { kind: "pending" }
	| { kind: "topic"; chatId: number | string; routeMode: "private_topic" | "forum_supergroup_topic" }
	| { kind: "selector"; chatId: number | string };

export function usesForumSupergroupRouting(config: TelegramConfig): boolean {
	return config.topicMode === "forum_supergroup" || ((config.topicMode ?? "auto") === "auto" && config.fallbackMode === "forum_supergroup");
}

export function targetChatIdForRoutes(config: TelegramConfig): number | string | undefined {
	return usesForumSupergroupRouting(config) ? config.fallbackSupergroupChatId : config.allowedChatId;
}

export function routesForSession(brokerState: BrokerState, sessionId: string): Array<[string, TelegramRoute]> {
	return Object.entries(brokerState.routes).filter(([, route]) => route.sessionId === sessionId);
}

export function cleanupTargetsActiveRoute(brokerState: BrokerState, cleanupRoute: TelegramRoute): boolean {
	return Object.values(brokerState.routes).some((route) => routeMatchesTopicIdentity(route, cleanupRoute));
}

export function queueRouteCleanup(brokerState: BrokerState, route: TelegramRoute): void {
	if (route.messageThreadId === undefined) return;
	brokerState.pendingRouteCleanups ??= {};
	brokerState.pendingRouteCleanups[route.routeId] = {
		route,
		createdAtMs: brokerState.pendingRouteCleanups[route.routeId]?.createdAtMs ?? now(),
		updatedAtMs: now(),
	};
}

export function removePendingCleanupForActiveRoute(brokerState: BrokerState, route: TelegramRoute): void {
	for (const [cleanupId, cleanup] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		if (routeMatchesTopicIdentity(route, cleanup.route)) delete brokerState.pendingRouteCleanups![cleanupId];
	}
}

export function detachRoutesForSessionAndQueueCleanup(brokerState: BrokerState, sessionId: string): TelegramRoute[] {
	const removedRoutes: TelegramRoute[] = [];
	for (const [id, route] of routesForSession(brokerState, sessionId)) {
		removedRoutes.push(route);
		queueRouteCleanup(brokerState, route);
		delete brokerState.routes[id];
	}
	return removedRoutes;
}

function retargetPendingManualCompactionsToRoute(brokerState: BrokerState, sessionId: string, route: TelegramRoute): void {
	for (const operation of Object.values(brokerState.pendingManualCompactions ?? {})) {
		if (operation.sessionId !== sessionId) continue;
		operation.routeId = route.routeId;
		operation.chatId = route.chatId;
		operation.messageThreadId = route.messageThreadId;
		operation.updatedAtMs = now();
	}
}

export function replaceRoutesForSession(brokerState: BrokerState, sessionId: string, route: TelegramRoute, routeKey = canonicalRouteKey(route)): void {
	retargetPendingManualCompactionsToRoute(brokerState, sessionId, route);
	for (const [id, previousRoute] of routesForSession(brokerState, sessionId)) {
		if (id === routeKey) continue;
		if (previousRoute.routeId === route.routeId) {
			delete brokerState.routes[id];
			continue;
		}
		queueRouteCleanup(brokerState, previousRoute);
		delete brokerState.routes[id];
	}
	brokerState.routes[routeKey] = route;
	removePendingCleanupForActiveRoute(brokerState, route);
}

function primaryExpectedRouteTarget(config: TelegramConfig, selectedChatId: number | string | undefined): ExpectedRouteTarget {
	const topicMode = config.topicMode ?? "auto";
	if (topicMode === "disabled") return { kind: "disabled" };
	if (topicMode === "single_chat_selector") return selectorRouteTarget(config, selectedChatId);
	const chatId = targetChatIdForRoutes(config);
	if (chatId === undefined) return { kind: "pending" };
	return { kind: "topic", chatId, routeMode: usesForumSupergroupRouting(config) ? "forum_supergroup_topic" : "private_topic" };
}

function selectorRouteTarget(config: TelegramConfig, selectedChatId: number | string | undefined): ExpectedRouteTarget {
	const chatId = targetChatIdForRoutes(config) ?? selectedChatId;
	return chatId === undefined ? { kind: "pending" } : { kind: "selector", chatId };
}

function routeMatchesExpectedTarget(route: TelegramRoute, expected: ExpectedRouteTarget): boolean {
	if (expected.kind === "disabled" || expected.kind === "pending") return false;
	if (String(route.chatId) !== String(expected.chatId)) return false;
	if (expected.kind === "selector") return route.routeMode === "single_chat_selector" && route.messageThreadId === undefined;
	return route.routeMode === expected.routeMode && route.messageThreadId !== undefined;
}

function reusableRouteForExpectedTarget(brokerState: BrokerState, sessionId: string, expected: ExpectedRouteTarget): TelegramRoute | undefined {
	if (expected.kind === "disabled" || expected.kind === "pending") return undefined;
	return routesForSession(brokerState, sessionId).map(([, route]) => route).find((route) => routeMatchesExpectedTarget(route, expected));
}

async function createTopicRoute(deps: EnsureRouteForSessionDeps, target: Extract<ExpectedRouteTarget, { kind: "topic" }>): Promise<TelegramRoute> {
	const { registration, sendTextReply, callTelegram } = deps;
	const topic = await callTelegram<TelegramForumTopic>("createForumTopic", { chat_id: target.chatId, name: registration.topicName });
	const route: TelegramRoute = {
		routeId: routeId(target.chatId, topic.message_thread_id),
		sessionId: registration.sessionId,
		chatId: target.chatId,
		messageThreadId: topic.message_thread_id,
		routeMode: target.routeMode,
		topicName: registration.topicName,
		createdAtMs: now(),
		updatedAtMs: now(),
	};
	replaceRoutesForSession(deps.brokerState, registration.sessionId, route);
	await sendTextReply(route.chatId, route.messageThreadId, `Connected pi session: ${registration.topicName}`).catch(() => undefined);
	return route;
}

async function createSelectorRoute(deps: EnsureRouteForSessionDeps, target: Extract<ExpectedRouteTarget, { kind: "selector" }>): Promise<TelegramRoute> {
	const { brokerState, registration, sendTextReply } = deps;
	const route: TelegramRoute = {
		routeId: routeId(target.chatId),
		sessionId: registration.sessionId,
		chatId: target.chatId,
		routeMode: "single_chat_selector",
		topicName: registration.topicName,
		createdAtMs: now(),
		updatedAtMs: now(),
	};
	replaceRoutesForSession(brokerState, registration.sessionId, route);
	await sendTextReply(route.chatId, undefined, `Connected pi session: ${registration.topicName}\nUse /sessions and /use to select sessions.`);
	return route;
}

function pendingRouteForRegistration(registration: SessionRegistration): TelegramRoute {
	return {
		routeId: `pending:${registration.sessionId}`,
		sessionId: registration.sessionId,
		chatId: 0,
		routeMode: "single_chat_selector",
		topicName: registration.topicName,
		createdAtMs: now(),
		updatedAtMs: now(),
	};
}

export async function ensureRouteForSessionInBroker(deps: EnsureRouteForSessionDeps): Promise<TelegramRoute> {
	const { brokerState, registration, config, selectedChatId } = deps;
	if (usesForumSupergroupRouting(config) && config.fallbackSupergroupChatId === undefined) {
		throw new Error("telegram.fallback_supergroup_chat_id is required for forum_supergroup fallback mode");
	}
	const primaryTarget = primaryExpectedRouteTarget(config, selectedChatId);
	if (primaryTarget.kind === "disabled") {
		detachRoutesForSessionAndQueueCleanup(brokerState, registration.sessionId);
		throw new TelegramRoutingDisabledError();
	}
	const primaryReuse = reusableRouteForExpectedTarget(brokerState, registration.sessionId, primaryTarget);
	if (primaryReuse) {
		replaceRoutesForSession(brokerState, registration.sessionId, primaryReuse);
		return primaryReuse;
	}
	if (primaryTarget.kind === "pending") {
		detachRoutesForSessionAndQueueCleanup(brokerState, registration.sessionId);
		return pendingRouteForRegistration(registration);
	}
	if (primaryTarget.kind === "topic") {
		if ((config.topicMode ?? "auto") === "auto" && (config.fallbackMode ?? "single_chat_selector") === "single_chat_selector") {
			const existingFallback = reusableRouteForExpectedTarget(brokerState, registration.sessionId, selectorRouteTarget(config, selectedChatId));
			if (existingFallback) {
				replaceRoutesForSession(brokerState, registration.sessionId, existingFallback);
				return existingFallback;
			}
		}
		const hasExistingRoutes = routesForSession(brokerState, registration.sessionId).length > 0;
		try {
			return await createTopicRoute(deps, primaryTarget);
		} catch (error) {
			if (getTelegramRetryAfterMs(error) !== undefined || config.topicMode === "private_topics" || usesForumSupergroupRouting(config) || config.fallbackMode === "disabled") throw error;
			if (hasExistingRoutes) {
				const existingFallbackTarget = selectorRouteTarget(config, selectedChatId);
				const existingFallback = reusableRouteForExpectedTarget(brokerState, registration.sessionId, existingFallbackTarget);
				if (existingFallback) {
					replaceRoutesForSession(brokerState, registration.sessionId, existingFallback);
					return existingFallback;
				}
				throw error;
			}
			// Auto mode falls back to selector routing for this new route only. Do not persistently downgrade config.
		}
	}
	const fallbackTarget = selectorRouteTarget(config, selectedChatId);
	if (fallbackTarget.kind === "pending") {
		detachRoutesForSessionAndQueueCleanup(brokerState, registration.sessionId);
		return pendingRouteForRegistration(registration);
	}
	if (fallbackTarget.kind !== "selector") throw new TelegramRoutingDisabledError();
	const fallbackReuse = reusableRouteForExpectedTarget(brokerState, registration.sessionId, fallbackTarget);
	if (fallbackReuse) {
		replaceRoutesForSession(brokerState, registration.sessionId, fallbackReuse);
		return fallbackReuse;
	}
	return await createSelectorRoute(deps, fallbackTarget);
}
