import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { TelegramRuntime } from "./extension.js";
import { executeTelegramAttachmentTool } from "./pi/attachments.js";
import { registerPromptSuffixHook } from "./pi/prompt.js";
import { MAX_ATTACHMENTS_PER_TURN, readConfig as readTelegramConfig, configureBrokerScope as configureTelegramBrokerScope, SESSION_REPLACEMENT_HANDOFFS_DIR, STATE_PATH } from "./shared/config.js";
import { errorMessage, randomId, readJson } from "./shared/utils.js";

export interface TelegramBootstrapOptions {
	loadRuntime?: (pi: ExtensionAPI) => Promise<TelegramRuntime>;
	readConfig?: typeof readTelegramConfig;
	configureBrokerScope?: typeof configureTelegramBrokerScope;
	hasMatchingSessionReplacementHandoff?: (options: { dir: string; context: { reason: "new" | "resume" | "fork"; previousSessionFile?: string; sessionFile?: string } }) => Promise<boolean>;
}

export function registerTelegramBootstrap(pi: ExtensionAPI, options: TelegramBootstrapOptions = {}): void {
	let runtimePromise: Promise<TelegramRuntime> | undefined;
	let runtime: TelegramRuntime | undefined;
	let runtimeSessionInitialized = false;
	let runtimeSessionInitializationPromise: Promise<void> | undefined;
	let shuttingDown = false;

	function assertNotShuttingDown(): void {
		if (shuttingDown) throw new Error("Telegram bridge is shutting down");
	}

	async function loadRuntime(): Promise<TelegramRuntime> {
		assertNotShuttingDown();
		if (runtime) return runtime;
		runtimePromise ??= (options.loadRuntime?.(pi) ?? import("./extension.js")
			.then((module) => module.createTelegramRuntime(pi)))
			.then((created) => {
				runtime = created;
				return created;
			})
			.catch((error) => {
				runtimePromise = undefined;
				throw error;
			});
		const loaded = await runtimePromise;
		assertNotShuttingDown();
		return loaded;
	}

	async function awaitStartedRuntime(): Promise<TelegramRuntime | undefined> {
		if (runtime) return runtime;
		if (!runtimePromise) return undefined;
		try {
			return await runtimePromise;
		} catch {
			return undefined;
		}
	}

	async function initializeRuntime(ctx: ExtensionContext, event: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string } = { reason: "startup" }): Promise<TelegramRuntime> {
		const loaded = await loadRuntime();
		if (!runtimeSessionInitialized) {
			runtimeSessionInitializationPromise ??= loaded.hooks.onSessionStart(ctx, event)
				.then(() => {
					runtimeSessionInitialized = true;
				})
				.catch((error) => {
					runtimeSessionInitializationPromise = undefined;
					throw error;
				});
			await runtimeSessionInitializationPromise;
			assertNotShuttingDown();
		} else {
			loaded.hooks.setLatestCtx(ctx);
		}
		return loaded;
	}

	function loadedRuntime(): TelegramRuntime | undefined {
		return runtime;
	}

	async function maybeLoadForSessionReplacement(event: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string }, ctx: ExtensionContext): Promise<TelegramRuntime | undefined> {
		if (event.reason !== "new" && event.reason !== "resume" && event.reason !== "fork") return undefined;
		const config = await (options.readConfig ?? readTelegramConfig)();
		(options.configureBrokerScope ?? configureTelegramBrokerScope)(config.botId);
		const hasMatchingHandoff = options.hasMatchingSessionReplacementHandoff ?? (await import("./client/session-replacement.js")).hasMatchingSessionReplacementHandoff;
		const context = { reason: event.reason, previousSessionFile: event.previousSessionFile, sessionFile: ctx.sessionManager.getSessionFile() };
		if (!config.botToken || !(await hasMatchingHandoff({ dir: SESSION_REPLACEMENT_HANDOFFS_DIR, context }))) return undefined;
		return await initializeRuntime(ctx, event);
	}

	function primeActiveCommandContext(loaded: TelegramRuntime, ctx: ExtensionCommandContext): void {
		loaded.hooks.setLatestCtx(ctx);
		if (!ctx.isIdle()) loaded.hooks.setCurrentAbort(() => ctx.abort());
	}

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token and pairing PIN",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			primeActiveCommandContext(loaded, ctx);
			assertNotShuttingDown();
			const configured = await loaded.hooks.promptForConfig(ctx);
			assertNotShuttingDown();
			if (configured) await loaded.hooks.connectTelegram(ctx, false);
		},
	});

	pi.registerCommand("telegram-topic-setup", {
		description: "Use a Telegram group as per-session topic home",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			primeActiveCommandContext(loaded, ctx);
			assertNotShuttingDown();
			const config = loaded.hooks.getConfig();
			if (!config.botToken || !config.allowedUserId) {
				assertNotShuttingDown();
				await loaded.hooks.connectTelegram(ctx, false);
			}
			ctx.ui.notify("In your Telegram group, send /topicsetup from the paired Telegram account. The bot must be an admin with permission to manage topics.", "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Connect this pi session to Telegram",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			primeActiveCommandContext(loaded, ctx);
			try {
				assertNotShuttingDown();
				await loaded.hooks.connectTelegram(ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				loaded.hooks.updateStatus(ctx, errorMessage(error));
			}
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Disconnect this pi session from Telegram",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			loaded.hooks.setLatestCtx(ctx);
			try {
				assertNotShuttingDown();
				await loaded.hooks.disconnectSessionRoute();
				loaded.hooks.hideTelegramStatus(ctx);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
				loaded.hooks.updateStatus(ctx, errorMessage(error));
			}
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			loaded.hooks.setLatestCtx(ctx);
			ctx.ui.notify(`owner: ${loaded.hooks.getOwnerId()} | session: ${loaded.hooks.getSessionId()} | broker: ${loaded.hooks.getIsBroker() ? "yes" : "no"} | route: ${loaded.hooks.getConnectedRoute()?.topicName ?? "none"}`, "info");
		},
	});

	pi.registerCommand("telegram-broker-status", {
		description: "Show Telegram broker status",
		handler: async (_args, ctx) => {
			const loaded = await initializeRuntime(ctx);
			loaded.hooks.setLatestCtx(ctx);
			const state = loaded.hooks.getBrokerState() ?? (await readJson<import("./shared/types.js").BrokerState>(STATE_PATH));
			const lease = await loaded.hooks.readLease();
			const total = state ? Object.keys(state.sessions).length : 0;
			const online = state ? Object.values(state.sessions).filter((session) => session.status !== "offline").length : 0;
			ctx.ui.notify(`broker: ${loaded.hooks.getIsBroker() ? "this session" : "other/none"} | owner: ${lease?.ownerId ?? "none"} | epoch: ${lease?.leaseEpoch ?? "none"} | lease until: ${lease?.leaseUntilMs ?? "none"} | sessions: ${online}/${total} | last update: ${state?.lastProcessedUpdateId ?? "none"}`, "info");
		},
	});

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
		execute: async (_toolCallId, params) => {
			if (!params.paths?.length) throw new Error("At least one attachment path is required");
			const loaded = await loadRuntime();
			assertNotShuttingDown();
			if (!loaded.hooks.getActiveTelegramTurn()) throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			return await executeTelegramAttachmentTool(params, loaded.hooks);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const alreadyLoaded = loadedRuntime();
		if (alreadyLoaded) {
			if (!runtimeSessionInitialized) {
				await initializeRuntime(ctx, event);
				return;
			}
			await alreadyLoaded.hooks.onSessionStart(ctx, event);
			return;
		}
		await maybeLoadForSessionReplacement(event, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		shuttingDown = true;
		const loaded = await awaitStartedRuntime();
		if (!loaded) return;
		await runtimeSessionInitializationPromise?.catch(() => undefined);
		loaded.hooks.clearMediaGroups();
		try {
			if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
				const handoffPrepared = await loaded.hooks.prepareSessionReplacementHandoff({ reason: event.reason, targetSessionFile: event.targetSessionFile }, ctx);
				if (handoffPrepared) {
					try {
						await loaded.hooks.shutdownClientRoute();
					} finally {
						await loaded.hooks.stopClientServer();
					}
				} else await loaded.hooks.disconnectSessionRoute("shutdown");
			} else {
				await loaded.hooks.disconnectSessionRoute("shutdown");
			}
		} finally {
			await loaded.hooks.stopBroker();
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		loadedRuntime()?.hooks.setLatestCtx(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const loaded = loadedRuntime();
		if (!loaded) return;
		loaded.hooks.setLatestCtx(ctx);
		loaded.hooks.onAgentRetryStart();
		loaded.hooks.setCurrentAbort(() => ctx.abort());
		loaded.hooks.updateStatus(ctx);
		loaded.hooks.drainDeferredCompactionTurns();
	});

	pi.on("input", async (event) => {
		const loaded = loadedRuntime();
		if (!loaded) return { action: "continue" };
		const connectedRoute = loaded.hooks.getConnectedRoute();
		if (!loaded.hooks.isRoutableRoute(connectedRoute) || event.source !== "interactive") return { action: "continue" };
		const text = event.text.trim();
		const imagesCount = event.images?.length ?? 0;
		const { isTelegramPrompt } = await import("./shared/format.js");
		if ((!text && imagesCount === 0) || text.startsWith("/") || isTelegramPrompt(text)) return { action: "continue" };
		const flushedDeferredTurnId = loaded.hooks.hasDeferredTelegramTurn() && !loaded.hooks.hasLiveAgentRun()
			? await loaded.hooks.flushDeferredTelegramTurn({ startNext: false })
			: undefined;
		void loaded.hooks.postIpc(loaded.hooks.getConnectedBrokerSocketPath(), "local_user_message", {
			text,
			imagesCount,
			routeId: connectedRoute.routeId,
			chatId: connectedRoute.chatId,
			messageThreadId: connectedRoute.messageThreadId,
		}, loaded.hooks.getSessionId()).catch(() => undefined);
		if (!loaded.hooks.getActiveTelegramTurn() && !loaded.hooks.hasAwaitingTelegramFinalTurn() && !(flushedDeferredTurnId && loaded.hooks.hasLiveAgentRun())) {
			loaded.hooks.beginLocalInteractiveTurn?.(connectedRoute, text);
			loaded.hooks.setActiveTelegramTurn?.({
				turnId: randomId("local"),
				sessionId: loaded.hooks.getSessionId(),
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

	registerPromptSuffixHook(pi);

	pi.on("message_start", async (event) => {
		const loaded = loadedRuntime();
		const activeTelegramTurn = loaded?.hooks.getActiveTelegramTurn();
		if (!loaded || !activeTelegramTurn) return;
		const { isAssistantMessage } = await import("./shared/messages.js");
		if (!isAssistantMessage(event.message)) return;
		loaded.hooks.onRetryMessageStart();
		await loaded.hooks.postIpc(loaded.hooks.getConnectedBrokerSocketPath(), "assistant_message_start", { turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId }, loaded.hooks.getSessionId()).catch(() => undefined);
	});

	pi.on("message_update", async (event) => {
		const loaded = loadedRuntime();
		const activeTelegramTurn = loaded?.hooks.getActiveTelegramTurn();
		if (!loaded || !activeTelegramTurn) return;
		const [{ isAssistantMessage, getThinkingTitleFromEvent }, { thinkingActivityLine }] = await Promise.all([import("./shared/messages.js"), import("./shared/activity-lines.js")]);
		if (!isAssistantMessage(event.message)) return;
		const streamEvent = event.assistantMessageEvent;
		if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
			loaded.hooks.activityReporter.post({ turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId, line: thinkingActivityLine(false, getThinkingTitleFromEvent(streamEvent)) });
		} else if (streamEvent.type === "thinking_end") {
			loaded.hooks.activityReporter.post({ turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId, line: thinkingActivityLine(true, getThinkingTitleFromEvent(streamEvent)) });
		}
	});

	pi.on("tool_call", async (event) => {
		const loaded = loadedRuntime();
		const activeTelegramTurn = loaded?.hooks.getActiveTelegramTurn();
		if (!loaded || !activeTelegramTurn) return { block: false };
		const { toolActivityLine } = await import("./shared/activity-lines.js");
		loaded.hooks.activityReporter.post({ turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId, line: toolActivityLine(event.toolName, event.input) });
		return { block: false };
	});

	pi.on("tool_result", async (event) => {
		const loaded = loadedRuntime();
		const activeTelegramTurn = loaded?.hooks.getActiveTelegramTurn();
		if (!loaded || !activeTelegramTurn) return {};
		const { toolActivityLine } = await import("./shared/activity-lines.js");
		loaded.hooks.activityReporter.post({ turnId: activeTelegramTurn.turnId, chatId: activeTelegramTurn.chatId, messageThreadId: activeTelegramTurn.messageThreadId, line: toolActivityLine(event.toolName, undefined, true, event.isError) });
		return {};
	});

	pi.on("agent_end", async (event, ctx) => {
		const loaded = loadedRuntime();
		if (!loaded) return;
		loaded.hooks.setLatestCtx(ctx);
		const turn = loaded.hooks.getActiveTelegramTurn();
		try {
			if (turn) {
				const [{ extractAssistantText }, { isRetryableAssistantError }] = await Promise.all([import("./shared/messages.js"), import("./shared/assistant-errors.js")]);
				const assistant = extractAssistantText(event.messages);
				const finalPayload = { turn, text: assistant.text, stopReason: assistant.stopReason, errorMessage: assistant.errorMessage, attachments: turn.queuedAttachments };
				const retryDeferred = !assistant.text?.trim() && isRetryableAssistantError(assistant.stopReason, assistant.errorMessage);
				if (retryDeferred) {
					await loaded.hooks.finalizeActiveTelegramTurn(finalPayload);
					await loaded.hooks.activityReporter.flush();
				} else {
					await loaded.hooks.prepareAssistantFinalForHandoff?.(finalPayload);
					await loaded.hooks.activityReporter.flush();
					await loaded.hooks.finalizeActiveTelegramTurn(finalPayload);
				}
			} else {
				loaded.hooks.startNextTelegramTurn();
			}
		} finally {
			loaded.hooks.setCurrentAbort(undefined);
			loaded.hooks.updateStatus(ctx);
		}
	});
}
