import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PiLifecycleHookDeps {
	setLatestCtx: (ctx: ExtensionContext) => void;
	setCurrentAbort: (abort: (() => void) | undefined) => void;
	prepareSessionReplacementHandoff: (event: { reason: "new" | "resume" | "fork"; targetSessionFile?: string }, ctx: ExtensionContext) => Promise<boolean>;
	stopClientServer: () => Promise<void>;
	shutdownClientRoute: () => Promise<void> | void;
	stopBroker: () => Promise<void>;
	updateStatus: (ctx: ExtensionContext) => void;
	onAgentRetryStart: () => void;
	startNextTelegramTurn: () => void;
	drainDeferredCompactionTurns: () => void;
	onSessionStart: (ctx: ExtensionContext, event: { reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string }) => Promise<void>;
	clearMediaGroups: () => void;
	disconnectSessionRoute: (mode?: "explicit" | "shutdown") => Promise<void>;
}

export function registerSessionLifecycleHooks(pi: ExtensionAPI, deps: PiLifecycleHookDeps): void {
	pi.on("session_start", async (event, ctx) => {
		deps.setLatestCtx(ctx);
		await deps.onSessionStart(ctx, event);
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

	pi.on("agent_start", async (_event, ctx) => {
		deps.setLatestCtx(ctx);
		deps.onAgentRetryStart();
		deps.setCurrentAbort(() => ctx.abort());
		deps.updateStatus(ctx);
		deps.drainDeferredCompactionTurns();
	});
}
