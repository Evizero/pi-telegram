import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJson } from "../src/shared/utils.js";

const dir = await mkdtemp(join(tmpdir(), "pi-telegram-json-"));
try {
	assert.equal(await readJson(join(dir, "missing.json")), undefined);

	const validPath = join(dir, "valid.json");
	await writeFile(validPath, "{\"ok\":true}\n", "utf8");
	assert.deepEqual(await readJson<{ ok: boolean }>(validPath), { ok: true });

	const malformedPath = join(dir, "malformed.json");
	await writeFile(malformedPath, "{not-json}\n", "utf8");
	await assert.rejects(() => readJson(malformedPath), SyntaxError);

	const directoryPath = join(dir, "directory.json");
	await mkdir(directoryPath);
	await assert.rejects(() => readJson(directoryPath), /EISDIR|illegal operation|is a directory/i);
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log("Durable JSON loading checks passed");
