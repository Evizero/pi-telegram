import type { TelegramRoute } from "../broker/types.js";
import type { ActiveTelegramTurn, PendingTelegramTurn } from "./types.js";

export interface TelegramClientRouteShutdownDeps {
	clearTurnLifecycle?: () => void;
	setQueuedTelegramTurns?: (turns: PendingTelegramTurn[]) => void;
	setActiveTelegramTurn?: (turn: ActiveTelegramTurn | undefined) => void;
	setConnectedRoute: (route: TelegramRoute | undefined) => void;
	clearAssistantFinalHandoff: () => void;
	clearAssistantFinalQueue?: boolean;
}

export function shutdownTelegramClientRoute(deps: TelegramClientRouteShutdownDeps): void {
	if (deps.clearTurnLifecycle) deps.clearTurnLifecycle();
	else {
		deps.setQueuedTelegramTurns?.([]);
		deps.setActiveTelegramTurn?.(undefined);
	}
	if (deps.clearAssistantFinalQueue ?? true) deps.clearAssistantFinalHandoff();
	deps.setConnectedRoute(undefined);
}
