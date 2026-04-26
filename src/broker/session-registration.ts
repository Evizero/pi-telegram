import type { BrokerState, PendingTelegramTurn, SessionRegistration, TelegramConfig, TelegramMessage, TelegramRoute } from "../shared/types.js";
import { topicNameFor } from "../shared/format.js";
import { now } from "../shared/utils.js";
import { ensureRouteForSessionInBroker } from "./routes.js";

export interface BrokerSessionRegistrationDeps {
	getBrokerState: () => BrokerState | undefined;
	setBrokerState: (state: BrokerState) => void;
	loadBrokerState: () => Promise<BrokerState>;
	persistBrokerState: () => Promise<void>;
	getConfig: () => TelegramConfig;
	selectedChatIdForSession: (sessionId: string) => number | string | undefined;
	sendTextReply: (chatId: number | string, messageThreadId: number | undefined, text: string) => Promise<number | undefined>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;
	postStaleClientConnection: (session: SessionRegistration) => void;
	clearDisconnectRequest: (sessionId: string) => Promise<void>;
	refreshTelegramStatus: () => void;
	retryPendingTurns: () => void;
	kickAssistantFinalLedger: () => void;
	createTelegramTurnForSession: (messages: TelegramMessage[], sessionIdForTurn: string) => Promise<PendingTelegramTurn>;
	staleStandDownGraceMs: number;
}

export function isStaleSessionConnection(previous: SessionRegistration, incoming: SessionRegistration): boolean {
	if (previous.connectionStartedAtMs !== incoming.connectionStartedAtMs) return previous.connectionStartedAtMs > incoming.connectionStartedAtMs;
	return previous.connectionNonce !== incoming.connectionNonce;
}

export function isStaleSessionConnectionError(error: unknown): boolean {
	return error instanceof Error && /stale_session_connection/i.test(error.message);
}

export class BrokerSessionRegistrationCoordinator {
	private readonly routeEnsures = new Map<string, Promise<TelegramRoute>>();

	constructor(private readonly deps: BrokerSessionRegistrationDeps) {}

	async registerSession(registration: SessionRegistration): Promise<TelegramRoute> {
		const brokerState = await this.brokerState();
		registration.lastHeartbeatMs = now();
		registration.topicName = topicNameFor(registration);
		const previous = brokerState.sessions[registration.sessionId];
		if (previous && isStaleSessionConnection(previous, registration)) throw new Error("stale_session_connection");
		const replacement = previous
			&& (previous.connectionNonce !== registration.connectionNonce || previous.connectionStartedAtMs !== registration.connectionStartedAtMs)
			&& !(previous.pid === registration.pid && previous.clientSocketPath === registration.clientSocketPath);
		if (replacement) this.deps.postStaleClientConnection(previous);
		brokerState.sessions[registration.sessionId] = {
			...registration,
			status: replacement ? "connecting" : (registration.status === "connecting" ? "idle" : registration.status),
			staleStandDownConnectionNonce: replacement ? previous.connectionNonce : undefined,
			staleStandDownRequestedAtMs: replacement ? now() : undefined,
		};
		const route = await this.ensureRouteForSessionLocked(brokerState.sessions[registration.sessionId]);
		await this.deps.clearDisconnectRequest(registration.sessionId);
		await this.deps.persistBrokerState();
		this.deps.refreshTelegramStatus();
		return route;
	}

	async heartbeatSession(registration: SessionRegistration): Promise<{ ok: true; route?: TelegramRoute }> {
		const brokerState = await this.brokerState();
		const previous = brokerState.sessions[registration.sessionId];
		if (!previous) throw new Error("Session is not registered");
		if (isStaleSessionConnection(previous, registration)) throw new Error("stale_session_connection");
		this.releaseExpiredStaleStandDownFence(previous);
		const fenced = previous.staleStandDownConnectionNonce !== undefined;
		brokerState.sessions[registration.sessionId] = {
			...previous,
			...registration,
			status: fenced ? "connecting" : registration.status,
			lastHeartbeatMs: now(),
			topicName: topicNameFor(registration),
		};
		const route = await this.ensureRouteForSessionLocked(brokerState.sessions[registration.sessionId]);
		await this.deps.persistBrokerState();
		this.deps.refreshTelegramStatus();
		if (!fenced) {
			this.deps.retryPendingTurns();
			this.deps.kickAssistantFinalLedger();
		}
		return { ok: true, route };
	}

	async ensureRoutesAfterPairing(): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return;
		for (const session of Object.values(brokerState.sessions)) await this.ensureRouteForSessionLocked(session);
		await this.deps.persistBrokerState();
	}

	createTelegramTurnForSession(messages: TelegramMessage[], sessionIdForTurn: string): Promise<PendingTelegramTurn> {
		return this.deps.createTelegramTurnForSession(messages, sessionIdForTurn);
	}

	private async brokerState(): Promise<BrokerState> {
		const existing = this.deps.getBrokerState();
		if (existing) return existing;
		const loaded = await this.deps.loadBrokerState();
		this.deps.setBrokerState(loaded);
		return loaded;
	}

	private ensureRouteForSessionLocked(registration: SessionRegistration): Promise<TelegramRoute> {
		const existing = this.routeEnsures.get(registration.sessionId);
		if (existing) return existing;
		const ensure = this.ensureRouteForSession(registration).finally(() => this.routeEnsures.delete(registration.sessionId));
		this.routeEnsures.set(registration.sessionId, ensure);
		return ensure;
	}

	private async ensureRouteForSession(registration: SessionRegistration): Promise<TelegramRoute> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) throw new Error("Broker state is not loaded");
		return await ensureRouteForSessionInBroker({
			brokerState,
			registration,
			config: this.deps.getConfig(),
			selectedChatId: this.deps.selectedChatIdForSession(registration.sessionId),
			sendTextReply: this.deps.sendTextReply,
			callTelegram: this.deps.callTelegram,
		});
	}

	private releaseExpiredStaleStandDownFence(session: SessionRegistration): void {
		if (!session.staleStandDownRequestedAtMs) return;
		if (now() - session.staleStandDownRequestedAtMs < this.deps.staleStandDownGraceMs) return;
		delete session.staleStandDownConnectionNonce;
		delete session.staleStandDownRequestedAtMs;
	}
}
