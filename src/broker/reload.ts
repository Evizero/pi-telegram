import type { BrokerState, SessionRegistration, TelegramReloadIntent } from "../shared/types.js";
import { now } from "../shared/utils.js";

export function markReloadStartedInState(
	brokerState: BrokerState,
	targetSessionId: string,
	payload: { intentId?: string; ownerId?: string },
): void {
	const intent = brokerState.reloadIntents?.[targetSessionId];
	if (!intent || intent.intentId !== payload.intentId || !payload.ownerId) throw new Error("Reload intent not found");
	intent.state = "reloading";
	intent.startedAtMs = now();
	intent.startedOwnerId = payload.ownerId;
	intent.updatedAtMs = now();
}

export function reloadIntentForReattachedRuntime(
	brokerState: BrokerState | undefined,
	registration: SessionRegistration,
): TelegramReloadIntent | undefined {
	const intent = brokerState?.reloadIntents?.[registration.sessionId];
	if (!intent || intent.state !== "reloading" || !intent.startedOwnerId || intent.startedOwnerId === registration.ownerId) return undefined;
	return intent;
}
