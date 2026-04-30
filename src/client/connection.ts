import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TelegramRoute } from "../broker/types.js";
import type { TelegramUser } from "../telegram/types.js";
import type { TelegramConfig } from "../shared/config-types.js";
import type { BrokerLease } from "../broker/types.js";

export interface TelegramClientConnectionDeps {
	setLatestContext: (ctx: ExtensionContext) => string;
	showTelegramStatus: (ctx: ExtensionContext) => void;
	readConfig: () => Promise<TelegramConfig>;
	setConfig: (config: TelegramConfig) => void;
	getConfig: () => TelegramConfig;
	applyBrokerScope: () => void;
	promptForConfig: (ctx: ExtensionContext) => Promise<boolean>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	writeConfig: (config: TelegramConfig) => Promise<void>;
	startClientServer: () => Promise<void>;
	readLease: () => Promise<BrokerLease | undefined>;
	isLeaseLive: (lease: BrokerLease | undefined) => Promise<boolean>;
	postReloadConfig: (socketPath: string) => Promise<void>;
	registerWithBroker: (ctx: ExtensionContext, socketPath: string) => Promise<TelegramRoute>;
	tryAcquireBroker: () => Promise<boolean>;
	ensureBrokerStarted: (ctx: ExtensionContext) => Promise<void>;
	getLocalBrokerSocketPath: () => string;
}

export async function connectTelegramClient(ctx: ExtensionContext, deps: TelegramClientConnectionDeps, notify = true): Promise<void> {
	deps.setLatestContext(ctx);
	deps.showTelegramStatus(ctx);
	let config = await deps.readConfig();
	deps.setConfig(config);
	deps.applyBrokerScope();
	if (!config.botToken) {
		const configured = await deps.promptForConfig(ctx);
		config = deps.getConfig();
		if (!configured || !config.botToken) return;
		deps.applyBrokerScope();
	}
	if (config.botToken && config.botId === undefined) {
		const user = await deps.callTelegram<TelegramUser>("getMe", {});
		config.botId = user.id;
		config.botUsername = user.username;
		config.topicsEnabled = user.has_topics_enabled;
		await deps.writeConfig(config);
		deps.applyBrokerScope();
	}
	await deps.startClientServer();
	const lease = await deps.readLease();
	if (await deps.isLeaseLive(lease)) {
		try {
			await deps.postReloadConfig(lease!.socketPath).catch(() => undefined);
			const route = await deps.registerWithBroker(ctx, lease!.socketPath);
			if (notify) ctx.ui.notify(`Telegram connected: ${route.topicName ?? "session"}`, "info");
			return;
		} catch {
			// Try election below.
		}
	}
	await new Promise((resolveValue) => setTimeout(resolveValue, Math.floor(Math.random() * 500)));
	if (await deps.tryAcquireBroker()) {
		await deps.ensureBrokerStarted(ctx);
		const route = await deps.registerWithBroker(ctx, deps.getLocalBrokerSocketPath());
		if (notify) ctx.ui.notify(`Telegram broker started: ${route.topicName}`, "info");
		return;
	}
	const nextLease = await deps.readLease();
	if (await deps.isLeaseLive(nextLease)) {
		await deps.registerWithBroker(ctx, nextLease!.socketPath);
		return;
	}
	throw new Error("Could not connect to or become Telegram broker");
}
