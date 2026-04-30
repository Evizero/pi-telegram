interface RouteIdentity {
	routeId: string;
	sessionId: string;
	chatId: number | string;
	messageThreadId?: number;
	routeMode: "private_topic" | "forum_supergroup_topic" | "single_chat_selector";
}

interface RouteBoundTurn {
	sessionId: string;
	routeId?: string;
	chatId: number | string;
	messageThreadId?: number;
}

export function canonicalRouteKey(route: RouteIdentity): string {
	return route.routeMode === "single_chat_selector" ? `${route.routeId}:${route.sessionId}` : route.routeId;
}

export function routeMatchesTopicIdentity(activeRoute: RouteIdentity, cleanupRoute: RouteIdentity): boolean {
	if (activeRoute.routeId === cleanupRoute.routeId) return true;
	return String(activeRoute.chatId) === String(cleanupRoute.chatId)
		&& activeRoute.messageThreadId !== undefined
		&& activeRoute.messageThreadId === cleanupRoute.messageThreadId;
}

export function turnBelongsToRoute(turn: RouteBoundTurn, route: RouteIdentity): boolean {
	if (turn.sessionId !== route.sessionId) return false;
	if (turn.routeId !== undefined) return turn.routeId === route.routeId;
	return String(turn.chatId) === String(route.chatId) && turn.messageThreadId === route.messageThreadId;
}

export function routeBoundControlBelongsToRoute(control: RouteBoundTurn, route: RouteIdentity): boolean {
	if (control.sessionId !== route.sessionId) return false;
	if (control.routeId !== undefined) return control.routeId === route.routeId;
	return String(control.chatId) === String(route.chatId) && control.messageThreadId === route.messageThreadId;
}

export function retargetTurnToRoute<TTurn extends RouteBoundTurn>(turn: TTurn, oldSessionId: string, newSessionId: string, route: RouteIdentity): TTurn {
	if (turn.sessionId !== oldSessionId) return turn;
	return {
		...turn,
		sessionId: newSessionId,
		routeId: turn.routeId === undefined || turn.routeId === route.routeId ? route.routeId : turn.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
	};
}
