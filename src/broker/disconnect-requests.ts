import type { BrokerState } from "../shared/types.js";

export interface PendingDisconnectRequest {
	sessionId: string;
	requestedAtMs: number;
}

export async function processDisconnectRequestsInBroker(options: {
	brokerState: BrokerState;
	requests: PendingDisconnectRequest[];
	unregisterSession: (sessionId: string) => Promise<unknown>;
	clearRequest: (sessionId: string) => Promise<void>;
}): Promise<void> {
	for (const request of options.requests) {
		const session = options.brokerState.sessions[request.sessionId];
		if (session && session.lastHeartbeatMs >= request.requestedAtMs) {
			await options.clearRequest(request.sessionId);
			continue;
		}
		await options.unregisterSession(request.sessionId);
		await options.clearRequest(request.sessionId);
	}
}
