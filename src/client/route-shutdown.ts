import type { ActiveTelegramTurn, PendingTelegramTurn, TelegramRoute } from "../shared/types.js";
import type { AssistantFinalRetryQueue } from "./final-delivery.js";

export interface TelegramClientRouteShutdownDeps {
	setQueuedTelegramTurns: (turns: PendingTelegramTurn[]) => void;
	setActiveTelegramTurn: (turn: ActiveTelegramTurn | undefined) => void;
	setConnectedRoute: (route: TelegramRoute | undefined) => void;
	assistantFinalQueue: AssistantFinalRetryQueue;
	clearAssistantFinalQueue?: boolean;
}

export function shutdownTelegramClientRoute(deps: TelegramClientRouteShutdownDeps): void {
	deps.setQueuedTelegramTurns([]);
	deps.setActiveTelegramTurn(undefined);
	if (deps.clearAssistantFinalQueue ?? true) deps.assistantFinalQueue.clear();
	deps.setConnectedRoute(undefined);
}
