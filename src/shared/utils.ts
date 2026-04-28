import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function now(): number {
	return Date.now();
}

export function randomId(prefix: string): string {
	return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function hashSecret(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export async function ensurePrivateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
	await chmod(path, 0o700).catch(() => undefined);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tempPath, JSON.stringify(value, null, "\t") + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
	await chmod(tempPath, 0o600).catch(() => undefined);
	await rename(tempPath, path);
}

export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function execGit(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { execFile } = await import("node:child_process");
		return await new Promise((resolveValue) => {
			execFile("git", args, { cwd, timeout: 1500 }, (error, stdout) => {
				if (error) resolveValue(undefined);
				else resolveValue(stdout.trim() || undefined);
			});
		});
	} catch {
		return undefined;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
