import type { BrokerState, SessionRegistration, TelegramRoute } from "../shared/types.js";

export interface PendingDisconnectRequest {
	sessionId: string;
	requestedAtMs: number;
	connectionNonce?: string;
	connectionStartedAtMs?: number;
	routeId?: string;
	chatId?: number | string;
	messageThreadId?: number;
	routeCreatedAtMs?: number;
}

export function isRouteScopedDisconnectRequest(request: PendingDisconnectRequest): boolean {
	return request.routeId !== undefined || request.chatId !== undefined || request.messageThreadId !== undefined;
}

export function disconnectRequestMatchesRoute(request: PendingDisconnectRequest, route: TelegramRoute): boolean {
	if (route.sessionId !== request.sessionId) return false;
	if (request.routeId !== undefined && route.routeId !== request.routeId) return false;
	if (request.chatId !== undefined && String(route.chatId) !== String(request.chatId)) return false;
	if (request.messageThreadId !== undefined && route.messageThreadId !== request.messageThreadId) return false;
	if (request.routeCreatedAtMs !== undefined && route.createdAtMs !== request.routeCreatedAtMs) return false;
	if (request.routeCreatedAtMs === undefined && route.createdAtMs >= request.requestedAtMs) return false;
	return isRouteScopedDisconnectRequest(request);
}

export function disconnectRequestBelongsToCurrentConnection(request: PendingDisconnectRequest, session: SessionRegistration | undefined): boolean {
	if (!session) return false;
	if (request.connectionNonce && session.connectionNonce !== request.connectionNonce) return false;
	if (request.connectionStartedAtMs !== undefined && session.connectionStartedAtMs !== request.connectionStartedAtMs) return false;
	return session.connectionStartedAtMs <= request.requestedAtMs;
}

export async function processDisconnectRequestsInBroker(options: {
	brokerState: BrokerState;
	requests: PendingDisconnectRequest[];
	unregisterSession: (sessionId: string) => Promise<unknown>;
	honorRouteScopedDisconnect?: (request: PendingDisconnectRequest) => Promise<{ honored: boolean }>;
	clearRequest: (sessionId: string) => Promise<void>;
}): Promise<void> {
	for (const request of options.requests) {
		const session = options.brokerState.sessions[request.sessionId];
		if (isRouteScopedDisconnectRequest(request)) {
			const result = await options.honorRouteScopedDisconnect?.(request);
			if (result?.honored || !Object.values(options.brokerState.routes).some((route) => disconnectRequestMatchesRoute(request, route))) {
				await options.clearRequest(request.sessionId);
			}
			continue;
		}
		if (session) {
			if (request.connectionNonce && session.connectionNonce && session.connectionNonce !== request.connectionNonce) {
				await options.clearRequest(request.sessionId);
				continue;
			}
			if (session.connectionStartedAtMs > request.requestedAtMs) {
				await options.clearRequest(request.sessionId);
				continue;
			}
		} else if (
			Object.values(options.brokerState.pendingTurns ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)
			|| Object.values(options.brokerState.pendingAssistantFinals ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)
		) {
			await options.clearRequest(request.sessionId);
			continue;
		}
		if (Object.values(options.brokerState.pendingAssistantFinals ?? {}).some((entry) => entry.turn.sessionId === request.sessionId)) continue;
		await options.unregisterSession(request.sessionId);
		await options.clearRequest(request.sessionId);
	}
}
