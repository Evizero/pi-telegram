import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { thinkingActivityLine, toolActivityLine } from "../shared/activity-lines.js";
import { getThinkingTitleFromEvent, isAssistantMessage } from "../shared/messages.js";
import type { ActiveTelegramTurn } from "../client/types.js";

export interface PiActivityReporter {
	post(payload: { turnId: string; activityId?: string; chatId: number | string; messageThreadId?: number; line: string }): void;
	flush(): Promise<void>;
}

export interface PiActivityHookDeps {
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	getConnectedBrokerSocketPath: () => string;
	getSessionId: () => string;
	activityReporter: PiActivityReporter;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	onRetryMessageStart: () => void;
}

export function registerActivityMirrorHooks(pi: ExtensionAPI, deps: PiActivityHookDeps): void {
	function postActivity(turn: ActiveTelegramTurn, line: string): void {
		deps.activityReporter.post({ turnId: turn.turnId, chatId: turn.chatId, messageThreadId: turn.messageThreadId, line });
	}

	pi.on("message_start", async (event) => {
		const activeTelegramTurn = deps.getActiveTelegramTurn();
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		deps.onRetryMessageStart();
		await deps.postIpc(deps.getConnectedBrokerSocketPath(), "assistant_message_start", { turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId }, deps.getSessionId()).catch(() => undefined);
	});

	pi.on("message_update", async (event) => {
		const activeTelegramTurn = deps.getActiveTelegramTurn();
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
			postActivity(activeTelegramTurn, thinkingActivityLine(false, getThinkingTitleFromEvent(streamEvent)));
		} else if (streamEvent.type === "thinking_end") {
			postActivity(activeTelegramTurn, thinkingActivityLine(true, getThinkingTitleFromEvent(streamEvent)));
		}
	});

	pi.on("tool_call", async (event) => {
		const activeTelegramTurn = deps.getActiveTelegramTurn();
		if (!activeTelegramTurn) return { block: false };
		postActivity(activeTelegramTurn, toolActivityLine(event.toolName, event.input));
		return { block: false };
	});

	pi.on("tool_result", async (event) => {
		const activeTelegramTurn = deps.getActiveTelegramTurn();
		if (!activeTelegramTurn) return {};
		postActivity(activeTelegramTurn, toolActivityLine(event.toolName, undefined, true, event.isError));
		return {};
	});
}
