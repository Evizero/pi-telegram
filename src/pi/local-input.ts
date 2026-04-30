import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { isTelegramPrompt } from "../shared/format.js";
import type { ActiveTelegramTurn, PendingTelegramTurn, TelegramRoute } from "../shared/types.js";
import { randomId } from "../shared/utils.js";

export interface PiLocalInputHookDeps {
	getConnectedRoute: () => TelegramRoute | undefined;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	hasDeferredTelegramTurn: () => boolean;
	hasAwaitingTelegramFinalTurn: () => boolean;
	hasLiveAgentRun: () => boolean;
	flushDeferredTelegramTurn: (options?: { startNext?: boolean }) => Promise<string | undefined>;
	beginLocalInteractiveTurn?: (route: TelegramRoute, historyText: string) => void;
	setActiveTelegramTurn?: (turn: ActiveTelegramTurn | undefined) => void;
	setQueuedTelegramTurns?: (turns: PendingTelegramTurn[]) => void;
	getSessionId: () => string;
	getConnectedBrokerSocketPath: () => string;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
}

export function registerLocalInputMirrorHook(pi: ExtensionAPI, deps: PiLocalInputHookDeps): void {
	pi.on("input", async (event) => {
		const connectedRoute = deps.getConnectedRoute();
		if (!deps.isRoutableRoute(connectedRoute) || event.source !== "interactive") return { action: "continue" };
		const text = event.text.trim();
		const imagesCount = event.images?.length ?? 0;
		if ((!text && imagesCount === 0) || text.startsWith("/") || isTelegramPrompt(text)) return { action: "continue" };
		const flushedDeferredTurnId = deps.hasDeferredTelegramTurn() && !deps.hasLiveAgentRun()
			? await deps.flushDeferredTelegramTurn({ startNext: false })
			: undefined;
		void deps.postIpc(deps.getConnectedBrokerSocketPath(), "local_user_message", {
			text,
			imagesCount,
			routeId: connectedRoute.routeId,
			chatId: connectedRoute.chatId,
			messageThreadId: connectedRoute.messageThreadId,
		}, deps.getSessionId()).catch(() => undefined);
		if (!deps.getActiveTelegramTurn() && !deps.hasAwaitingTelegramFinalTurn() && !(flushedDeferredTurnId && deps.hasLiveAgentRun())) {
			if (deps.beginLocalInteractiveTurn) deps.beginLocalInteractiveTurn(connectedRoute, text);
			else deps.setActiveTelegramTurn?.({
				turnId: randomId("local"),
				sessionId: deps.getSessionId(),
				routeId: connectedRoute.routeId,
				chatId: connectedRoute.chatId,
				messageThreadId: connectedRoute.messageThreadId,
				replyToMessageId: 0,
				queuedAttachments: [],
				content: [],
				historyText: text,
			});
		}
		return { action: "continue" };
	});
}
