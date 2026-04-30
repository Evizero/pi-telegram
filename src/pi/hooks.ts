import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { MAX_ATTACHMENTS_PER_TURN, MAX_FILE_BYTES, STATE_PATH, SYSTEM_PROMPT_SUFFIX } from "../shared/config.js";
import { thinkingActivityLine, toolActivityLine, type ActivityReporter } from "../broker/activity.js";
import { isTelegramPrompt } from "../shared/format.js";
import { isRetryableAssistantError } from "../shared/assistant-errors.js";
import { extractAssistantText, getThinkingTitleFromEvent, isAssistantMessage } from "../shared/messages.js";
import type { ActiveTelegramTurn, BrokerState, PendingTelegramTurn, QueuedAttachment, TelegramRoute } from "../shared/types.js";
import { errorMessage, randomId, readJson } from "../shared/utils.js";

export interface RuntimePiHooksDeps {
	getConfig: () => { botToken?: string; allowedUserId?: number };
	setLatestCtx: (ctx: ExtensionContext) => void;
	getConnectedRoute: () => TelegramRoute | undefined;
	setConnectedRoute: (route: TelegramRoute | undefined) => void;
	getActiveTelegramTurn: () => ActiveTelegramTurn | undefined;
	hasDeferredTelegramTurn: () => boolean;
	hasAwaitingTelegramFinalTurn: () => boolean;
	hasLiveAgentRun: () => boolean;
	flushDeferredTelegramTurn: (options?: { startNext?: boolean }) => Promise<string | undefined>;
	queueActiveTelegramAttachments?: (attachments: QueuedAttachment[], maxAttachments: number) => void;
	beginLocalInteractiveTurn?: (route: TelegramRoute, historyText: string) => void;
	setActiveTelegramTurn?: (turn: ActiveTelegramTurn | undefined) => void;
	setQueuedTelegramTurns?: (turns: PendingTelegramTurn[]) => void;
	setCurrentAbort: (abort: (() => void) | undefined) => void;
	getSessionId: () => string;
	getOwnerId: () => string;
	getIsBroker: () => boolean;
	getBrokerState: () => BrokerState | undefined;
	getConnectedBrokerSocketPath: () => string;
	activityReporter: ActivityReporter;
	isRoutableRoute: (route: TelegramRoute | undefined) => route is TelegramRoute;
	resolveAllowedAttachmentPath: (inputPath: string) => Promise<string | undefined>;
	postIpc: <TResponse>(socketPath: string, type: string, payload: unknown, targetSessionId?: string) => Promise<TResponse>;
	promptForConfig: (ctx: ExtensionContext) => Promise<boolean>;
	connectTelegram: (ctx: ExtensionContext, notify?: boolean) => Promise<void>;
	unregisterSession: (sessionId: string) => Promise<unknown>;
	markSessionOffline: (sessionId: string) => Promise<unknown>;
	disconnectSessionRoute: (mode?: "explicit" | "shutdown") => Promise<void>;
	prepareSessionReplacementHandoff: (event: { reason: "new" | "resume" | "fork"; targetSessionFile?: string }, ctx: ExtensionContext) => Promise<boolean>;
	stopClientServer: () => Promise<void>;
	shutdownClientRoute: () => Promise<void> | void;
	stopBroker: () => Promise<void>;
	hideTelegramStatus: (ctx: ExtensionContext) => void;
	updateStatus: (ctx: ExtensionContext, error?: string) => void;
	readLease: () => Promise<{ ownerId?: string; leaseEpoch?: number; leaseUntilMs?: number } | undefined>;
	sendAssistantFinalToBroker: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<boolean>;
	prepareAssistantFinalForHandoff?: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<void>;
	finalizeActiveTelegramTurn: (payload: { turn: PendingTelegramTurn; text?: string; stopReason?: string; errorMessage?: string; attachments: QueuedAttachment[] }) => Promise<"completed" | "deferred">;
	onAgentRetryStart: () => void;
	onRetryMessageStart: () => void;
	startNextTelegramTurn: () => void;
	drainDeferredCompactionTurns: () => void;
	onSessionStart: (ctx: ExtensionContext, event: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string }) => Promise<void>;
	clearMediaGroups: () => void;
}

export function registerRuntimePiHooks(pi: ExtensionAPI, deps: RuntimePiHooksDeps): void {
	function postActivity(turn: ActiveTelegramTurn, line: string): void {
		deps.activityReporter.post({ turnId: turn.turnId, chatId: turn.chatId, messageThreadId: turn.messageThreadId, line });
	}

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

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token and pairing PIN",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			const configured = await deps.promptForConfig(ctx);
			if (configured) await deps.connectTelegram(ctx, false);
		},
	});

	pi.registerCommand("telegram-topic-setup", {
		description: "Use a Telegram group as per-session topic home",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			const config = deps.getConfig();
			if (!config.botToken || !config.allowedUserId) await deps.connectTelegram(ctx, false);
			ctx.ui.notify("In your Telegram group, send /topicsetup from the paired Telegram account. The bot must be an admin with permission to manage topics.", "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Connect this pi session to Telegram",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			try {
				await deps.connectTelegram(ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				deps.updateStatus(ctx, errorMessage(error));
			}
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Disconnect this pi session from Telegram",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			try {
				await deps.disconnectSessionRoute();
				deps.hideTelegramStatus(ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				deps.updateStatus(ctx, errorMessage(error));
			}
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			ctx.ui.notify(`owner: ${deps.getOwnerId()} | session: ${deps.getSessionId()} | broker: ${deps.getIsBroker() ? "yes" : "no"} | route: ${deps.getConnectedRoute()?.topicName ?? "none"}`, "info");
		},
	});

	pi.registerCommand("telegram-broker-status", {
		description: "Show Telegram broker status",
		handler: async (_args, ctx) => {
			deps.setLatestCtx(ctx);
			const state = deps.getBrokerState() ?? (await readJson<BrokerState>(STATE_PATH));
			const lease = await deps.readLease();
			const total = state ? Object.keys(state.sessions).length : 0;
			const online = state ? Object.values(state.sessions).filter((session) => session.status !== "offline").length : 0;
			ctx.ui.notify(`broker: ${deps.getIsBroker() ? "this session" : "other/none"} | owner: ${lease?.ownerId ?? "none"} | epoch: ${lease?.leaseEpoch ?? "none"} | lease until: ${lease?.leaseUntilMs ?? "none"} | sessions: ${online}/${total} | last update: ${state?.lastProcessedUpdateId ?? "none"}`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		deps.setLatestCtx(ctx);
		await deps.onSessionStart(ctx, event);
	});

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

	pi.on("session_shutdown", async (event, ctx) => {
		deps.clearMediaGroups();
		try {
			if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
				const handoffPrepared = await deps.prepareSessionReplacementHandoff({ reason: event.reason, targetSessionFile: event.targetSessionFile }, ctx);
				if (handoffPrepared) {
					try {
						await deps.shutdownClientRoute();
					} finally {
						await deps.stopClientServer();
					}
				} else await deps.disconnectSessionRoute("shutdown");
			} else {
				await deps.disconnectSessionRoute("shutdown");
			}
		} finally {
			await deps.stopBroker();
		}
	});

	pi.on("model_select", async (_event, ctx) => deps.setLatestCtx(ctx));

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt) ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.` : SYSTEM_PROMPT_SUFFIX;
		return { systemPrompt: event.systemPrompt + suffix };
	});

	pi.on("agent_start", async (_event, ctx) => {
		deps.setLatestCtx(ctx);
		deps.onAgentRetryStart();
		deps.setCurrentAbort(() => ctx.abort());
		deps.updateStatus(ctx);
		deps.drainDeferredCompactionTurns();
	});

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

	pi.on("agent_end", async (event, ctx) => {
		deps.setLatestCtx(ctx);
		const turn = deps.getActiveTelegramTurn();
		let finalizationResult: "completed" | "deferred" | undefined;
		try {
			if (turn) {
				const assistant = extractAssistantText(event.messages);
				const finalPayload = { turn, text: assistant.text, stopReason: assistant.stopReason, errorMessage: assistant.errorMessage, attachments: turn.queuedAttachments };
				const retryDeferred = !assistant.text?.trim() && isRetryableAssistantError(assistant.stopReason, assistant.errorMessage);
				if (retryDeferred) {
					finalizationResult = await deps.finalizeActiveTelegramTurn(finalPayload);
					await deps.activityReporter.flush();
				} else {
					await deps.prepareAssistantFinalForHandoff?.(finalPayload);
					await deps.activityReporter.flush();
					finalizationResult = await deps.finalizeActiveTelegramTurn(finalPayload);
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
