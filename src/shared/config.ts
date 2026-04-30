import { join } from "node:path";
import { homedir } from "node:os";

import type { TelegramConfig } from "./config-types.js";
import { baseBrokerDir, CONFIG_PATH } from "./paths.js";
import { ensurePrivateDir, invalidDurableJson, isRecord, readJson, writeJson } from "./utils.js";

// Transitional compatibility export for persisted config path consumers. New
// runtime code should import path, limit, timing, prompt, and Telegram policy
// constants from their bounded owner modules instead of adding unrelated
// concepts to this config surface.
export { CONFIG_PATH } from "./paths.js";

type RawTelegramConfig = TelegramConfig & Record<string, unknown>;

function configValue(raw: RawTelegramConfig, camel: keyof TelegramConfig, snake: string): unknown {
	if (Object.prototype.hasOwnProperty.call(raw, camel)) return raw[camel];
	if (Object.prototype.hasOwnProperty.call(raw, snake)) return raw[snake];
	return undefined;
}

function validateRawField(path: string, raw: RawTelegramConfig, key: string, kind: "string" | "number" | "boolean" | "chatId" | "topicMode" | "fallbackMode"): void {
	if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
	const value = raw[key];
	if (value === undefined) return;
	if (kind === "string" && typeof value !== "string") invalidDurableJson(path, `${key} must be a string when present`);
	if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) invalidDurableJson(path, `${key} must be a finite number when present`);
	if (kind === "boolean" && typeof value !== "boolean") invalidDurableJson(path, `${key} must be a boolean when present`);
	if (kind === "chatId" && typeof value !== "number" && typeof value !== "string") invalidDurableJson(path, `${key} must be a number or string when present`);
	if (kind === "chatId" && typeof value === "number" && !Number.isFinite(value)) invalidDurableJson(path, `${key} must be finite when numeric`);
	if (kind === "topicMode" && !validTopicMode(value)) invalidDurableJson(path, `${key} must be a known topic mode when present`);
	if (kind === "fallbackMode" && !validFallbackMode(value)) invalidDurableJson(path, `${key} must be a known fallback mode when present`);
}

function readOptionalString(raw: RawTelegramConfig, camel: keyof TelegramConfig, snake: string, context = "telegram config"): string | undefined {
	const value = configValue(raw, camel, snake);
	if (value === undefined) return undefined;
	if (typeof value !== "string") invalidDurableJson(context, `${String(camel)} must be a string when present`);
	return value;
}

function readOptionalNumber(raw: RawTelegramConfig, camel: keyof TelegramConfig, snake: string, context = "telegram config"): number | undefined {
	const value = configValue(raw, camel, snake);
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) invalidDurableJson(context, `${String(camel)} must be a finite number when present`);
	return value;
}

function readOptionalBoolean(raw: RawTelegramConfig, camel: keyof TelegramConfig, snake: string, context = "telegram config"): boolean | undefined {
	const value = configValue(raw, camel, snake);
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") invalidDurableJson(context, `${String(camel)} must be a boolean when present`);
	return value;
}

function validateRawTelegramConfig(path: string, value: unknown): RawTelegramConfig | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) invalidDurableJson(path, "root value must be an object");
	const raw = value as RawTelegramConfig;
	for (const key of ["botToken", "bot_token", "botUsername", "bot_username", "pairingCodeHash", "pairing_code_hash"]) validateRawField(path, raw, key, "string");
	for (const key of ["botId", "bot_id", "allowedUserId", "allowed_user_id", "allowedChatId", "allowed_chat_id", "pairingCreatedAtMs", "pairing_created_at_ms", "pairingExpiresAtMs", "pairing_expires_at_ms", "pairingFailedAttempts", "pairing_failed_attempts", "version", "lastUpdateId", "last_update_id"]) validateRawField(path, raw, key, "number");
	for (const key of ["topicsEnabled", "topics_enabled"]) validateRawField(path, raw, key, "boolean");
	for (const key of ["fallbackSupergroupChatId", "fallback_supergroup_chat_id"]) validateRawField(path, raw, key, "chatId");
	for (const key of ["topicMode", "topic_mode"]) validateRawField(path, raw, key, "topicMode");
	for (const key of ["fallbackMode", "fallback_mode"]) validateRawField(path, raw, key, "fallbackMode");
	return raw;
}

function validTopicMode(value: unknown): value is TelegramConfig["topicMode"] {
	return value === "auto" || value === "private_topics" || value === "forum_supergroup" || value === "single_chat_selector" || value === "disabled";
}

function validFallbackMode(value: unknown): value is TelegramConfig["fallbackMode"] {
	return value === "forum_supergroup" || value === "single_chat_selector" || value === "disabled";
}

function readOptionalTopicMode(raw: RawTelegramConfig, context = "telegram config"): TelegramConfig["topicMode"] | undefined {
	const value = configValue(raw, "topicMode", "topic_mode");
	if (value === undefined) return undefined;
	if (!validTopicMode(value)) invalidDurableJson(context, "topicMode must be a known topic mode when present");
	return value;
}

function readOptionalFallbackMode(raw: RawTelegramConfig, context = "telegram config"): TelegramConfig["fallbackMode"] | undefined {
	const value = configValue(raw, "fallbackMode", "fallback_mode");
	if (value === undefined) return undefined;
	if (!validFallbackMode(value)) invalidDurableJson(context, "fallbackMode must be a known fallback mode when present");
	return value;
}

function readOptionalChatId(raw: RawTelegramConfig, context = "telegram config"): number | string | undefined {
	const value = configValue(raw, "fallbackSupergroupChatId", "fallback_supergroup_chat_id");
	if (value === undefined) return undefined;
	if (typeof value !== "number" && typeof value !== "string") invalidDurableJson(context, "fallbackSupergroupChatId must be a number or string when present");
	if (typeof value === "number" && !Number.isFinite(value)) invalidDurableJson(context, "fallbackSupergroupChatId must be finite when numeric");
	return value;
}

function normalizeRawTelegramConfig(raw: RawTelegramConfig): TelegramConfig {
	const config: TelegramConfig = {};
	function assign<TKey extends keyof TelegramConfig>(key: TKey, value: TelegramConfig[TKey] | undefined): void {
		if (value !== undefined) config[key] = value;
	}
	assign("botToken", readOptionalString(raw, "botToken", "bot_token"));
	assign("botUsername", readOptionalString(raw, "botUsername", "bot_username"));
	assign("botId", readOptionalNumber(raw, "botId", "bot_id"));
	assign("allowedUserId", readOptionalNumber(raw, "allowedUserId", "allowed_user_id"));
	assign("allowedChatId", readOptionalNumber(raw, "allowedChatId", "allowed_chat_id"));
	assign("fallbackSupergroupChatId", readOptionalChatId(raw));
	assign("pairingCodeHash", readOptionalString(raw, "pairingCodeHash", "pairing_code_hash"));
	assign("pairingCreatedAtMs", readOptionalNumber(raw, "pairingCreatedAtMs", "pairing_created_at_ms"));
	assign("pairingExpiresAtMs", readOptionalNumber(raw, "pairingExpiresAtMs", "pairing_expires_at_ms"));
	assign("pairingFailedAttempts", readOptionalNumber(raw, "pairingFailedAttempts", "pairing_failed_attempts"));
	assign("topicsEnabled", readOptionalBoolean(raw, "topicsEnabled", "topics_enabled"));
	assign("topicMode", readOptionalTopicMode(raw));
	assign("fallbackMode", readOptionalFallbackMode(raw));
	assign("version", readOptionalNumber(raw, "version", "version"));
	assign("lastUpdateId", readOptionalNumber(raw, "lastUpdateId", "last_update_id"));
	return config;
}

export async function readConfig(): Promise<TelegramConfig> {
	const brokerConfigPath = join(baseBrokerDir(), "config.json");
	const brokerRaw = validateRawTelegramConfig(brokerConfigPath, await readJson<unknown>(brokerConfigPath));
	const userRaw = validateRawTelegramConfig(CONFIG_PATH, await readJson<unknown>(CONFIG_PATH));
	const raw = { ...(brokerRaw ? normalizeRawTelegramConfig(brokerRaw) : {}), ...(userRaw ? normalizeRawTelegramConfig(userRaw) : {}) };
	const config: TelegramConfig = {
		...raw,
		botToken: raw.botToken ?? process.env.PI_TELEGRAM_BOT_TOKEN,
	};
	if (config.allowedUserId !== undefined && config.allowedChatId === undefined) {
		config.allowedChatId = config.allowedUserId;
	}
	return config;
}

export async function writeConfig(config: TelegramConfig): Promise<void> {
	await ensurePrivateDir(join(homedir(), ".pi", "agent"));
	await writeJson(CONFIG_PATH, {
		version: 2,
		bot_token: config.botToken,
		bot_username: config.botUsername,
		bot_id: config.botId,
		allowed_user_id: config.allowedUserId,
		allowed_chat_id: config.allowedChatId,
		fallback_supergroup_chat_id: config.fallbackSupergroupChatId,
		pairing_code_hash: config.pairingCodeHash,
		pairing_created_at_ms: config.pairingCreatedAtMs,
		pairing_expires_at_ms: config.pairingExpiresAtMs,
		pairing_failed_attempts: config.pairingFailedAttempts,
		topics_enabled: config.topicsEnabled,
		topic_mode: config.topicMode,
		fallback_mode: config.fallbackMode,
	});
}
