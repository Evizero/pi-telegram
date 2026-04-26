import type { ActiveTelegramTurn, PendingTelegramTurn, TelegramRoute } from "../shared/types.js";

export interface TelegramClientRouteShutdownDeps {
	setQueuedTelegramTurns: (turns: PendingTelegramTurn[]) => void;
	setActiveTelegramTurn: (turn: ActiveTelegramTurn | undefined) => void;
	setConnectedRoute: (route: TelegramRoute | undefined) => void;
	clearAssistantFinalHandoff: () => void;
	clearAssistantFinalQueue?: boolean;
}

export function shutdownTelegramClientRoute(deps: TelegramClientRouteShutdownDeps): void {
	deps.setQueuedTelegramTurns([]);
	deps.setActiveTelegramTurn(undefined);
	if (deps.clearAssistantFinalQueue ?? true) deps.clearAssistantFinalHandoff();
	deps.setConnectedRoute(undefined);
}
