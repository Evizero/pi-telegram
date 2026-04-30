import type { TelegramMessage } from "../telegram/types.js";

export function telegramCommandName(text: string): string {
	const command = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
	return command.includes("@") ? command.slice(0, command.indexOf("@")) : command;
}

export function telegramCommandArgs(text: string): string {
	const trimmed = text.trim();
	const match = trimmed.match(/^\S+\s+([\s\S]*)$/);
	return match?.[1]?.trim() ?? "";
}

export function messagesWithFirstText(messages: TelegramMessage[], text: string): TelegramMessage[] {
	return messages.map((message, index) => {
		if (index !== 0) return message;
		if (message.caption !== undefined && message.text === undefined) return { ...message, caption: text };
		return { ...message, text };
	});
}
