import type { BrokerState, TelegramConfig, TelegramRoute } from "./types.js";

export function telegramStatusText(options: {
	theme: any;
	visible: boolean;
	config: TelegramConfig;
	isBroker: boolean;
	brokerState?: BrokerState;
	connectedRoute?: TelegramRoute;
	error?: string;
}): string | undefined {
	if (!options.visible) return undefined;
	const { theme, config, isBroker, brokerState, connectedRoute, error } = options;
	const label = theme.fg("accent", "telegram");
	if (error) return `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`;
	if (!config.botToken) return `${label} ${theme.fg("muted", "not configured")}`;
	if (isBroker) {
		const count = brokerState ? Object.values(brokerState.sessions).filter((session) => session.status !== "offline").length : 0;
		return `${label} ${theme.fg("accent", "broker")} ${theme.fg("muted", `${count} sessions`)}`;
	}
	if (connectedRoute) return `${label} ${theme.fg("success", "connected")} ${theme.fg("muted", connectedRoute.topicName)}`;
	return `${label} ${theme.fg("muted", "disconnected")}`;
}

export function pairingInstructions(botUsername: string | undefined, code: string): string {
	const bot = botUsername ? `@${botUsername}` : "your Telegram bot";
	return `Telegram bot configured: ${bot}\n\nOpen ${bot} in Telegram and send this exact message within 10 minutes:\n\n/start ${code}`;
}
