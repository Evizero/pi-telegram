import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { MAX_ATTACHMENTS_PER_TURN, MAX_FILE_BYTES } from "../shared/config.js";
import type { ActiveTelegramTurn, QueuedAttachment } from "../shared/types.js";

export interface PiAttachmentHookDeps {
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	queueActiveTelegramAttachments?: (attachments: QueuedAttachment[], maxAttachments: number) => void;
	resolveAllowedAttachmentPath: (inputPath: string) => Promise<string | undefined>;
}

export function registerTelegramAttachmentTool(pi: ExtensionAPI, deps: PiAttachmentHookDeps): void {
	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!params.paths?.length) throw new Error("At least one attachment path is required");
			const validated: Array<{ path: string; fileName: string }> = [];
			for (const inputPath of params.paths) {
				const attachmentPath = await deps.resolveAllowedAttachmentPath(inputPath);
				if (!attachmentPath) throw new Error(`Attachment path is not allowed: ${inputPath}`);
				const stats = await stat(attachmentPath);
				if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
				if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large: ${inputPath}`);
				validated.push({ path: attachmentPath, fileName: basename(attachmentPath) });
			}
			if (deps.queueActiveTelegramAttachments) deps.queueActiveTelegramAttachments(validated, MAX_ATTACHMENTS_PER_TURN);
			else {
				const activeTelegramTurn = deps.getActiveTelegramTurn();
				if (!activeTelegramTurn) throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
				if (activeTelegramTurn.queuedAttachments.length + validated.length > MAX_ATTACHMENTS_PER_TURN) throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				activeTelegramTurn.queuedAttachments.push(...validated);
			}
			return { content: [{ type: "text", text: `Queued ${validated.length} Telegram attachment(s).` }], details: { paths: validated.map((entry) => entry.path) } };
		},
	});
}
