import { realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import { TEMP_DIR } from "../shared/paths.js";

const SENSITIVE_BASENAMES = new Set([
	"id_rsa",
	"id_ed25519",
	"application_default_credentials.json",
]);

const SENSITIVE_PATH_SEGMENTS = new Set([
	".ssh",
	".aws",
	".azure",
	".kube",
]);

export function isSensitiveAttachmentPath(absPath: string): boolean {
	const base = basename(absPath);
	if (base === ".env" || base.startsWith(".env.")) return true;
	if (SENSITIVE_BASENAMES.has(base)) return true;
	const segments = absPath.split("/").filter(Boolean);
	if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) return true;
	for (let index = 0; index < segments.length - 1; index += 1) {
		if (segments[index] === ".config" && segments[index + 1] === "gcloud") return true;
	}
	return false;
}

export async function resolveAllowedAttachmentPath(inputPath: string, cwdInput?: string): Promise<string | undefined> {
	const basePath = isAbsolute(inputPath) ? inputPath : resolve(cwdInput ?? process.cwd(), inputPath);
	const abs = await realpath(basePath).catch(() => resolve(basePath));
	const cwd = cwdInput ? await realpath(cwdInput).catch(() => resolve(cwdInput)) : undefined;
	const tmp = await realpath(TEMP_DIR).catch(() => resolve(TEMP_DIR));
	if (isSensitiveAttachmentPath(abs)) return undefined;
	const allowed = (cwd !== undefined && (abs === cwd || abs.startsWith(`${cwd}/`))) || abs.startsWith(`${tmp}/`);
	return allowed ? abs : undefined;
}
