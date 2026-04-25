import type { BrokerState } from "../shared/types.js";
import { now } from "../shared/utils.js";

export async function markSessionOfflineInBroker(options: {
	targetSessionId: string;
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	refreshTelegramStatus: () => void;
	stopTypingLoop: (turnId: string) => void;
}): Promise<{ ok: true }> {
	const { targetSessionId } = options;
	if (!targetSessionId) return { ok: true };
	let brokerState = options.getBrokerState();
	if (!brokerState) {
		brokerState = await options.loadBrokerState();
		options.setBrokerState(brokerState);
	}
	const session = brokerState.sessions[targetSessionId];
	if (session) {
		session.status = "offline";
		session.lastHeartbeatMs = now();
		session.activeTurnId = undefined;
		for (const [turnId, pending] of Object.entries(brokerState.pendingTurns ?? {})) {
			if (pending.turn.sessionId === targetSessionId) options.stopTypingLoop(turnId);
		}
		await options.persistBrokerState();
		options.refreshTelegramStatus();
	}
	return { ok: true };
}

export async function unregisterSessionFromBroker(options: {
	targetSessionId: string;
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	refreshTelegramStatus: () => void;
	stopTypingLoop: (turnId: string) => void;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
}): Promise<{ ok: true }> {
	const { targetSessionId } = options;
	if (!targetSessionId) return { ok: true };
	let brokerState = options.getBrokerState();
	if (!brokerState) {
		brokerState = await options.loadBrokerState();
		options.setBrokerState(brokerState);
	}
	delete brokerState.sessions[targetSessionId];
	for (const [id, route] of Object.entries(brokerState.routes)) {
		if (route.sessionId !== targetSessionId) continue;
		if (route.messageThreadId !== undefined) {
			await options.callTelegram("deleteForumTopic", { chat_id: route.chatId, message_thread_id: route.messageThreadId }).catch(() => undefined);
		}
		delete brokerState.routes[id];
	}
	if (brokerState.pendingTurns) {
		for (const [turnId, pending] of Object.entries(brokerState.pendingTurns)) {
			if (pending.turn.sessionId === targetSessionId) {
				options.stopTypingLoop(turnId);
				delete brokerState.pendingTurns[turnId];
			}
		}
	}
	await options.persistBrokerState();
	options.refreshTelegramStatus();
	return { ok: true };
}
