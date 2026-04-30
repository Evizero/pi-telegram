import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const repoRoot = process.cwd();
const sourceRoots = ["src", "scripts"];

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

const files = sourceRoots.flatMap(sourceFiles);
const broadTypeImports: string[] = [];
const broadConfigImports: string[] = [];

function resolvesTo(file: string, specifier: string, target: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const sourcePath = normalize(join(dirname(file), specifier.replace(/\.js$/, ".ts")));
	return sourcePath === target;
}

for (const file of files) {
	const text = readFileSync(join(repoRoot, file), "utf8");
	for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)) {
		if (file !== "src/shared/types.ts" && resolvesTo(file, match[1], "src/shared/types.ts")) {
			broadTypeImports.push(file);
		}
	}
	for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s+["']([^"']+)["'];/gs)) {
		if (!resolvesTo(file, match[2], "src/shared/config.ts")) continue;
		const imported = match[1]
			.split(",")
			.map((part) => part.trim().split(/\s+as\s+/)[0])
			.filter(Boolean);
		const disallowed = imported.filter((name) => !["readConfig", "writeConfig", "CONFIG_PATH"].includes(name));
		if (disallowed.length > 0) broadConfigImports.push(`${file}: ${disallowed.join(", ")}`);
	}
}

assert.deepEqual(broadTypeImports, [], "runtime code should import bounded owner type modules instead of src/shared/types.ts");
assert.deepEqual(broadConfigImports, [], "runtime code should import bounded policy/path modules instead of src/shared/config.ts constants");

console.log("Shared boundary checks passed");
