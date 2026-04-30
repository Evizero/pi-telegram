export interface TelegramConfig {
	version?: number;
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	allowedChatId?: number;
	fallbackSupergroupChatId?: number | string;
	lastUpdateId?: number;
	pairingCodeHash?: string;
	pairingCreatedAtMs?: number;
	pairingExpiresAtMs?: number;
	pairingFailedAttempts?: number;
	topicsEnabled?: boolean;
	topicMode?: "auto" | "private_topics" | "forum_supergroup" | "single_chat_selector" | "disabled";
	fallbackMode?: "forum_supergroup" | "single_chat_selector" | "disabled";
}
