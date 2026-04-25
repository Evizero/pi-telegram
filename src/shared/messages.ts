import type { AgentMessage } from "@mariozechner/pi-agent-core";

export function getMessageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("")
		.trim();
}

export function isAssistantMessage(message: AgentMessage): boolean {
	return (message as unknown as { role?: string }).role === "assistant";
}

const THINKING_TITLE_MAX_CHARS = 90;

function normalizeThinkingTitle(line: string): string | undefined {
	const title = line
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*•]\s+/, "")
		.replace(/^\*\*(.+?)\*\*:?$/, "$1")
		.replace(/^__(.+?)__:?$/, "$1")
		.replace(/^[_*`\"'“”‘’]+|[_*`\"'“”‘’]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title || title.length > THINKING_TITLE_MAX_CHARS) return undefined;
	if (/^(thinking|reasoning)\.?$/i.test(title)) return undefined;
	return title;
}

export function extractThinkingTitle(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const firstLine = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.find((line) => line.trim().length > 0);
	return firstLine ? normalizeThinkingTitle(firstLine) : undefined;
}

export function getThinkingTitleFromEvent(event: unknown): string | undefined {
	const value = event as Record<string, unknown>;
	if (typeof value.content === "string") return extractThinkingTitle(value.content);
	const contentIndex = typeof value.contentIndex === "number" ? value.contentIndex : undefined;
	const partial = value.partial as Record<string, unknown> | undefined;
	const content = Array.isArray(partial?.content) ? partial.content : [];
	const block = contentIndex !== undefined ? content[contentIndex] : content.find((candidate) => (candidate as { type?: string }).type === "thinking");
	if (!block || typeof block !== "object" || (block as { type?: string }).type !== "thinking") return undefined;
	return extractThinkingTitle((block as { thinking?: string }).thinking);
}

export function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as unknown as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
		const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
		return { text: text || undefined, stopReason, errorMessage };
	}
	return {};
}
