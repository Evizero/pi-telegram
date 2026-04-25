import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { PendingTelegramTurn, QueuedAttachment, TelegramRoute } from "../shared/types.js";

export interface ClientCompactOptions {
	ctx: Pick<ExtensionContext, "compact"> | undefined;
	sessionId: string;
	getConnectedRoute: () => TelegramRoute | undefined;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	sendAssistantFinalToBroker: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<boolean>;
	createTurnId: () => string;
	formatError: (error: unknown) => string;
	onStart?: () => void;
	onSettled?: () => void;
}

function commandTurn(turnId: string, sessionId: string, route: TelegramRoute): PendingTelegramTurn {
	return {
		turnId,
		sessionId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
		replyToMessageId: 0,
		queuedAttachments: [],
		content: [],
		historyText: "",
	};
}

export function clientCompactSession(options: ClientCompactOptions): { text: string } {
	const { ctx } = options;
	if (!ctx) return { text: "Session context unavailable." };

	const resultRoute = options.getConnectedRoute();
	const sendResult = (text: string): void => {
		if (!options.isRoutableRoute(resultRoute)) return;
		void options.sendAssistantFinalToBroker({
			turn: commandTurn(options.createTurnId(), options.sessionId, resultRoute),
			text,
			attachments: [],
		});
	};

	options.onStart?.();
	try {
		ctx.compact({
			onComplete: () => {
				sendResult("Compaction completed.");
				options.onSettled?.();
			},
			onError: (error) => {
				sendResult(`Compaction failed: ${options.formatError(error)}`);
				options.onSettled?.();
			},
		});
		return { text: "Compaction started." };
	} catch (error) {
		options.onSettled?.();
		return { text: `Compaction failed: ${options.formatError(error)}` };
	}
}
