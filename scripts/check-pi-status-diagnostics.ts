import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";

import { createPiDiagnosticReporter } from "../src/pi/diagnostics.js";
import { telegramStatusText } from "../src/shared/ui-status.js";

const theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function readSourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...readSourceFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function checkDurableTelegramStatusText(): void {
	assert.equal(
		telegramStatusText({ theme, visible: true, config: {}, isBroker: false }),
		"telegram not configured",
	);
	assert.equal(
		telegramStatusText({
			theme,
			visible: true,
			config: { botToken: "token" },
			isBroker: true,
			brokerState: { sessions: { one: { status: "idle" }, two: { status: "busy" }, gone: { status: "offline" } } },
		}),
		"telegram broker 2 sessions",
	);
	assert.equal(
		telegramStatusText({ theme, visible: true, config: { botToken: "token" }, isBroker: false, connectedRoute: { topicName: "topic" } }),
		"telegram connected topic",
	);
	assert.equal(
		telegramStatusText({ theme, visible: true, config: { botToken: "token" }, isBroker: false }),
		"telegram disconnected",
	);
	assert.equal(
		telegramStatusText({ theme, visible: false, config: { botToken: "token" }, isBroker: false }),
		undefined,
	);
	assert.equal(
		telegramStatusText({ theme, visible: true, config: { botToken: "token" }, isBroker: false, error: "poll failed" } as Parameters<typeof telegramStatusText>[0]),
		"telegram disconnected",
	);
}

function checkPiDiagnosticsNotifyWithoutSessionMessages(): void {
	const notifications: Array<{ message: string; severity?: string }> = [];
	const ctx = {
		ui: { notify: (message: string, severity?: string) => { notifications.push({ message, severity }); } },
	} as ExtensionContext;
	const report = createPiDiagnosticReporter({ getLatestContext: () => ctx });

	report({ message: "quiet transient", severity: "warning" });
	report({ message: "actionable warning", severity: "warning", notify: true });
	report({ message: "terminal failure", severity: "error", notify: true });

	assert.deepEqual(notifications, [
		{ message: "actionable warning", severity: "info" },
		{ message: "terminal failure", severity: "error" },
	]);
}

function checkSourceHasNoDiagnosticFooterOrSessionMessagePath(): void {
	const sourceFiles = readSourceFiles("src");
	for (const path of sourceFiles) {
		const text = readFileSync(path, "utf8");
		assert.equal(text.includes("statusDetail"), false, `${path} should not route diagnostic detail through statusDetail`);
	}
	assert.equal(readFileSync("src/pi/diagnostics.ts", "utf8").includes("sendMessage"), false, "pi diagnostics should not inject session messages");
	assert.equal(readFileSync("src/broker/updates.ts", "utf8").includes("updateStatus(ctx,"), false, "poll-loop failures should not override footer status");
	assert.equal(readFileSync("src/shared/ui-status.ts", "utf8").includes("error?:"), false, "status formatter should not accept transient error overrides");
}

checkDurableTelegramStatusText();
checkPiDiagnosticsNotifyWithoutSessionMessages();
checkSourceHasNoDiagnosticFooterOrSessionMessagePath();
console.log("Pi status diagnostics checks passed");
