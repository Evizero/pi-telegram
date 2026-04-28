import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { randomInt } from "node:crypto";

import type { TelegramConfig, TelegramUser } from "../shared/types.js";
import { errorMessage, hashSecret, now } from "../shared/utils.js";
import { formatPairingPin, PAIRING_PIN_TTL_MS } from "../shared/pairing.js";
import { callTelegram, TelegramApiError } from "./api.js";
import { withTelegramRetry } from "./retry.js";

export interface TelegramConfigPromptOptions {
	setupInProgress: boolean;
	configureBrokerScope: (botId?: number) => void;
	writeConfig: (config: TelegramConfig) => Promise<void>;
	showTelegramStatus: (ctx: ExtensionContext) => void;
	showPairingInstructions: (ctx: ExtensionContext, pairingPin: string) => void;
	setSetupInProgress: (value: boolean) => void;
	setConfig: (config: TelegramConfig) => void;
}

export async function promptForTelegramConfig(ctx: ExtensionContext, config: TelegramConfig, options: TelegramConfigPromptOptions): Promise<boolean> {
	options.showTelegramStatus(ctx);
	if (!ctx.hasUI || options.setupInProgress) return false;
	options.setSetupInProgress(true);
	try {
		const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
		if (!token) return false;
		const nextConfig: TelegramConfig = {
			...config,
			botToken: token.trim(),
			topicMode: config.topicMode ?? "auto",
			fallbackMode: config.fallbackMode ?? "single_chat_selector",
			allowedUserId: undefined,
			allowedChatId: undefined,
		};
		let bot: TelegramUser;
		try {
			bot = await withTelegramRetry((signal) => callTelegram<TelegramUser>(nextConfig.botToken, "getMe", {}, { signal }));
		} catch (error) {
			ctx.ui.notify(error instanceof TelegramApiError ? (error.description || "Invalid Telegram bot token") : errorMessage(error), "error");
			return false;
		}
		nextConfig.botId = bot.id;
		nextConfig.botUsername = bot.username;
		options.configureBrokerScope(nextConfig.botId);
		nextConfig.topicsEnabled = bot.has_topics_enabled;
		const pairingPin = formatPairingPin(randomInt(10_000));
		const pairingStartedAtMs = now();
		nextConfig.pairingCodeHash = hashSecret(pairingPin);
		nextConfig.pairingCreatedAtMs = pairingStartedAtMs;
		nextConfig.pairingExpiresAtMs = pairingStartedAtMs + PAIRING_PIN_TTL_MS;
		nextConfig.pairingFailedAttempts = 0;
		options.setConfig(nextConfig);
		await options.writeConfig(nextConfig);
		options.showPairingInstructions(ctx, pairingPin);
		return true;
	} finally {
		options.setSetupInProgress(false);
	}
}
