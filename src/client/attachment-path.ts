import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { TEMP_DIR } from "../shared/config.js";

export async function resolveAllowedAttachmentPath(inputPath: string, cwdInput?: string): Promise<string | undefined> {
	const basePath = isAbsolute(inputPath) ? inputPath : resolve(cwdInput ?? process.cwd(), inputPath);
	const abs = await realpath(basePath).catch(() => resolve(basePath));
	const cwd = cwdInput ? await realpath(cwdInput).catch(() => resolve(cwdInput)) : undefined;
	const tmp = await realpath(TEMP_DIR).catch(() => resolve(TEMP_DIR));
	const base = basename(abs);
	if (base === ".env" || base.startsWith(".env.") || base === "id_rsa" || base === "id_ed25519" || abs.includes("/.ssh/") || abs.includes("/.aws/")) return undefined;
	const allowed = (cwd !== undefined && (abs === cwd || abs.startsWith(`${cwd}/`))) || abs.startsWith(`${tmp}/`);
	return allowed ? abs : undefined;
}
