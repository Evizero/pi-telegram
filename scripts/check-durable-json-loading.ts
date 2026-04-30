import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DurableJsonReadError, readJson } from "../src/shared/utils.js";

function checkConfigNullIsInvalid(): void {
	const compiledRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const configModuleUrl = pathToFileURL(join(compiledRoot, "src/shared/config.js")).href;
	const childHome = join(tmpdir(), `pi-telegram-config-${process.pid}-${Date.now()}`);
	const script = `
		import { mkdir, writeFile } from "node:fs/promises";
		import { dirname } from "node:path";
		import assert from "node:assert/strict";
		const { CONFIG_PATH, readConfig } = await import(${JSON.stringify(configModuleUrl)});
		await mkdir(dirname(CONFIG_PATH), { recursive: true });
		await writeFile(CONFIG_PATH, JSON.stringify({ botToken: null }), "utf8");
		await assert.rejects(() => readConfig(), /botToken must be a string/);
		await writeFile(CONFIG_PATH, JSON.stringify({ botToken: "valid-token" }), "utf8");
		const brokerConfigPath = dirname(CONFIG_PATH) + "/telegram-broker/config.json";
		await mkdir(dirname(brokerConfigPath), { recursive: true });
		await writeFile(brokerConfigPath, JSON.stringify({ allowedUserId: null }), "utf8");
		await assert.rejects(() => readConfig(), /allowedUserId must be a finite number/);
		await writeFile(brokerConfigPath, JSON.stringify({ allowedUserId: 123, allowed_user_id: null }), "utf8");
		await assert.rejects(() => readConfig(), /allowed_user_id must be a finite number/);
	`;
	execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: childHome } });
}

const dir = await mkdtemp(join(tmpdir(), "pi-telegram-json-"));
try {
	assert.equal(await readJson(join(dir, "missing.json")), undefined);

	const validPath = join(dir, "valid.json");
	await writeFile(validPath, "{\"ok\":true}\n", "utf8");
	assert.deepEqual(await readJson<{ ok: boolean }>(validPath), { ok: true });

	const malformedPath = join(dir, "malformed.json");
	await writeFile(malformedPath, "{not-json}\n", "utf8");
	await assert.rejects(
		() => readJson(malformedPath),
		(error: unknown) => error instanceof DurableJsonReadError && error.path === malformedPath && error.message.includes(malformedPath),
	);

	const directoryPath = join(dir, "directory.json");
	await mkdir(directoryPath);
	await assert.rejects(
		() => readJson(directoryPath),
		(error: unknown) => error instanceof DurableJsonReadError && error.path === directoryPath && /EISDIR|illegal operation|is a directory/i.test(error.message),
	);

	const unreadablePath = join(dir, "unreadable.json");
	await writeFile(unreadablePath, "{\"ok\":true}\n", "utf8");
	await chmod(unreadablePath, 0o000);
	try {
		await assert.rejects(
			() => readJson(unreadablePath),
			(error: unknown) => error instanceof DurableJsonReadError && error.path === unreadablePath && error.message.includes(unreadablePath),
		);
	} finally {
		await chmod(unreadablePath, 0o600).catch(() => undefined);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}

checkConfigNullIsInvalid();

console.log("Durable JSON loading checks passed");
