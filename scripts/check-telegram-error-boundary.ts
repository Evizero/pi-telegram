import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const repoRoot = process.cwd();
const sourceRoots = ["src", "scripts"];
const disallowedApiErrorImports = new Set(["TelegramApiError", "getTelegramRetryAfterMs", "telegramApiError"]);

function sourceFiles(dir: string): string[] {
	const entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(relative));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative);
	}
	return files;
}

function resolvesTo(file: string, specifier: string, target: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const sourcePath = normalize(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
	return sourcePath === target;
}

const violations: string[] = [];
for (const file of sourceRoots.flatMap(sourceFiles)) {
	if (file === "src/telegram/api.ts") continue;
	const text = readFileSync(join(repoRoot, file), "utf8");
	for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];/gs)) {
		if (!resolvesTo(file, match[2], "src/telegram/api.ts")) continue;
		const imported = match[1]
			.split(",")
			.map((part) => part.trim().split(/\s+as\s+/)[0])
			.filter(Boolean);
		const disallowed = imported.filter((name) => disallowedApiErrorImports.has(name));
		if (disallowed.length > 0) violations.push(`${file}: ${disallowed.join(", ")}`);
	}
}

assert.deepEqual(violations, [], "Telegram retry/error primitives should be imported from src/telegram/api-errors.ts, not src/telegram/api.ts");
console.log("Telegram error boundary checks passed");
