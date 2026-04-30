const WORKING_ACTIVITY_LINE = "⏳ working ...";

function compactValue(value: unknown): string {
	if (value === undefined) return "";
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > 90 ? `${text.slice(0, 87)}...` : text;
	} catch {
		return String(value);
	}
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function activityLineToHtml(line: string): string {
	const active = line.startsWith("*");
	const normalized = active ? line.slice(1) : line;
	if (normalized.startsWith("🧠 ") || normalized === WORKING_ACTIVITY_LINE) {
		const body = escapeHtml(normalized);
		return active ? `<b>${body}</b>` : body;
	}
	const match = normalized.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
	if (!match) return escapeHtml(normalized);
	const [, icon, name, rest] = match;
	const body = rest ? `${escapeHtml(icon)} ${escapeHtml(name)} <code>${escapeHtml(rest)}</code>` : `${escapeHtml(icon)} ${escapeHtml(name)}`;
	return active ? `<b>${body}</b>` : body;
}

function compactToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return compactValue(args);
	const record = args as Record<string, unknown>;
	if (toolName === "read") return compactValue(record.path);
	if (toolName === "bash") return compactValue(record.command);
	if (toolName === "edit" || toolName === "write") return compactValue(record.path);
	if (toolName === "grep" || toolName === "find") return compactValue(record.pattern ?? record.query ?? record.path);
	if (toolName === "ls") return compactValue(record.path);
	return compactValue(args);
}

function toolIconAndName(toolName: string, isError?: boolean): { icon: string; name: string } {
	if (isError) return { icon: "❌", name: toolName === "bash" ? "$" : toolName };
	if (toolName === "bash") return { icon: "💻", name: "$" };
	if (toolName === "read") return { icon: "📖", name: "read" };
	if (toolName === "write") return { icon: "📝", name: "write" };
	if (toolName === "edit") return { icon: "📝", name: "edit" };
	return { icon: "🔧", name: toolName };
}

export function toolActivityLine(toolName: string, args?: unknown, done?: boolean, isError?: boolean): string {
	const { icon, name } = toolIconAndName(toolName, isError);
	const suffix = args === undefined || done ? "" : ` ${compactToolArgs(toolName, args)}`;
	return `${done ? "" : "*"}${icon} ${name}${suffix}`;
}

export function thinkingActivityLine(done: boolean, title?: string): string {
	const normalizedTitle = title?.trim();
	if (!normalizedTitle) return `${done ? "" : "*"}${WORKING_ACTIVITY_LINE}`;
	return `${done ? "" : "*"}🧠 ${normalizedTitle}`;
}

export function normalizedActivityLine(line: string): string {
	return line.startsWith("*") ? line.slice(1) : line;
}

export function isWorkingActivityLine(line: string): boolean {
	return normalizedActivityLine(line) === WORKING_ACTIVITY_LINE;
}

export function isThinkingActivityLine(line: string): boolean {
	return normalizedActivityLine(line).startsWith("🧠 ");
}
