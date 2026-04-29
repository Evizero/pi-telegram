import type { PendingTelegramTurn, QueuedTurnControlState, TelegramRoute } from "./types.js";

export function canonicalRouteKey(route: TelegramRoute): string {
	return route.routeMode === "single_chat_selector" ? `${route.routeId}:${route.sessionId}` : route.routeId;
}

export function routeMatchesTopicIdentity(activeRoute: TelegramRoute, cleanupRoute: TelegramRoute): boolean {
	if (activeRoute.routeId === cleanupRoute.routeId) return true;
	return String(activeRoute.chatId) === String(cleanupRoute.chatId)
		&& activeRoute.messageThreadId !== undefined
		&& activeRoute.messageThreadId === cleanupRoute.messageThreadId;
}

export function turnBelongsToRoute(turn: PendingTelegramTurn, route: TelegramRoute): boolean {
	if (turn.sessionId !== route.sessionId) return false;
	if (turn.routeId !== undefined) return turn.routeId === route.routeId;
	return String(turn.chatId) === String(route.chatId) && turn.messageThreadId === route.messageThreadId;
}

export function routeBoundControlBelongsToRoute(control: QueuedTurnControlState, route: TelegramRoute): boolean {
	if (control.sessionId !== route.sessionId) return false;
	if (control.routeId !== undefined) return control.routeId === route.routeId;
	return String(control.chatId) === String(route.chatId) && control.messageThreadId === route.messageThreadId;
}

export function retargetTurnToRoute(turn: PendingTelegramTurn, oldSessionId: string, newSessionId: string, route: TelegramRoute): PendingTelegramTurn {
	if (turn.sessionId !== oldSessionId) return turn;
	return {
		...turn,
		sessionId: newSessionId,
		routeId: turn.routeId === undefined || turn.routeId === route.routeId ? route.routeId : turn.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
	};
}
