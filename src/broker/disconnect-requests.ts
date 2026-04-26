import type { BrokerState } from "../shared/types.js";

export interface PendingDisconnectRequest {
	sessionId: string;
	requestedAtMs: number;
	connectionNonce?: string;
}

export async function processDisconnectRequestsInBroker(options: {
	brokerState: BrokerState;
	requests: PendingDisconnectRequest[];
	unregisterSession: (sessionId: string) => Promise<unknown>;
	clearRequest: (sessionId: string) => Promise<void>;
}): Promise<void> {
	for (const request of options.requests) {
		const session = options.brokerState.sessions[request.sessionId];
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
