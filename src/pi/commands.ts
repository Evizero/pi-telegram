import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { STATE_PATH } from "../shared/paths.js";
import type { BrokerState, TelegramRoute } from "../broker/types.js";
import { errorMessage, readJson } from "../shared/utils.js";

export interface PiCommandHookDeps {
	getConfig: () => { botToken?: string; allowedUserId?: number };
	setLatestCtx: (ctx: ExtensionContext) => void;
	getConnectedRoute: () => TelegramRoute | undefined;
	getSessionId: () => string;
	getOwnerId: () => string;
	getIsBroker: () => boolean;
	getBrokerState: () => BrokerState | undefined;
	promptForConfig: (ctx: ExtensionContext) => Promise<boolean>;
	connectTelegram: (ctx: ExtensionContext, notify?: boolean) => Promise<void>;
	disconnectSessionRoute: (mode?: "explicit" | "shutdown") => Promise<void>;
	hideTelegramStatus: (ctx: ExtensionContext) => void;
	updateStatus: (ctx: ExtensionContext, error?: string) => void;
	readLease: () => Promise<{ ownerId?: string; leaseEpoch?: number; leaseUntilMs?: number } | undefined>;
}

export function registerTelegramCommands(pi: ExtensionAPI, deps: PiCommandHookDeps): void {
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
}
