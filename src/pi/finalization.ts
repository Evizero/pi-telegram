import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { isRetryableAssistantError } from "../shared/assistant-errors.js";
import { extractAssistantText } from "../shared/messages.js";
import type { ActiveTelegramTurn, PendingTelegramTurn, QueuedAttachment } from "../client/types.js";
import type { PiActivityReporter } from "./activity.js";

export interface PiFinalizationHookDeps {
	setLatestCtx: (ctx: ExtensionContext) => void;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	setCurrentAbort: (abort: (() => void) | undefined) => void;
	activityReporter: PiActivityReporter;
	prepareAssistantFinalForHandoff?: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<void>;
	finalizeActiveTelegramTurn: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<"completed" | "deferred">;
	startNextTelegramTurn: () => void;
	updateStatus: (ctx: ExtensionContext, error?: string) => void;
}

export function registerAssistantFinalizationHook(pi: ExtensionAPI, deps: PiFinalizationHookDeps): void {
	pi.on("agent_end", async (event, ctx) => {
		deps.setLatestCtx(ctx);
		const turn = deps.getActiveTelegramTurn();
		try {
			if (turn) {
				const assistant = extractAssistantText(event.messages);
				const finalPayload = { turn, text: assistant.text, stopReason: assistant.stopReason, errorMessage: assistant.errorMessage, attachments: turn.queuedAttachments };
				const retryDeferred = !assistant.text?.trim() && isRetryableAssistantError(assistant.stopReason, assistant.errorMessage);
				if (retryDeferred) {
					await deps.finalizeActiveTelegramTurn(finalPayload);
					await deps.activityReporter.flush();
				} else {
					await deps.prepareAssistantFinalForHandoff?.(finalPayload);
					await deps.activityReporter.flush();
					await deps.finalizeActiveTelegramTurn(finalPayload);
				}
			} else {
				deps.startNextTelegramTurn();
			}
		} finally {
			deps.setCurrentAbort(undefined);
			deps.updateStatus(ctx);
		}
	});
}
