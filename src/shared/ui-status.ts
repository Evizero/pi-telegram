import type { Theme } from "@mariozechner/pi-coding-agent";

interface StatusConfig {
	botToken?: string;
}

interface StatusBrokerState {
	sessions: Record<string, { status: "connecting" | "idle" | "busy" | "offline" | "error" }>;
}

interface StatusRoute {
	topicName: string;
}

export function telegramStatusText(options: {
	theme: Theme;
	visible: boolean;
	config: StatusConfig;
	isBroker: boolean;
	brokerState?: StatusBrokerState;
	connectedRoute?: StatusRoute;
}): string | undefined {
	if (!options.visible) return undefined;
	const { theme, config, isBroker, brokerState, connectedRoute } = options;
	const label = theme.fg("accent", "telegram");
	if (!config.botToken) return `${label} ${theme.fg("muted", "not configured")}`;
	if (isBroker) {
		const count = brokerState ? Object.values(brokerState.sessions).filter((session) => session.status !== "offline").length : 0;
		return `${label} ${theme.fg("accent", "broker")} ${theme.fg("muted", `${count} sessions`)}`;
	}
	if (connectedRoute) return `${label} ${theme.fg("success", "connected")} ${theme.fg("muted", connectedRoute.topicName)}`;
	return `${label} ${theme.fg("muted", "disconnected")}`;
}

export function pairingInstructions(botUsername: string | undefined, pin: string): string {
	const bot = botUsername ? `@${botUsername}` : "your Telegram bot";
	return `Telegram bot configured: ${bot}\n\nOpen ${bot} in Telegram and send this 4-digit PIN within 5 minutes:\n\n${pin}\n\nIf needed, /start ${pin} also works.`;
}
