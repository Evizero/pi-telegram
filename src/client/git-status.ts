import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ClientGitRepositoryQueryRequest, ClientGitRepositoryQueryResult } from "../shared/types.js";
import { errorMessage } from "../shared/utils.js";

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER_BYTES = 128 * 1024;
const MAX_FILE_LINES = 18;
const MAX_TEXT_LENGTH = 3500;
const READ_ONLY_GIT_GLOBAL_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.external="];

export interface GitStatusEntry {
	code: string;
	path: string;
}

export interface ParsedGitStatus {
	branch?: string;
	head?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
	entries: GitStatusEntry[];
	warnings?: string[];
}

export interface ParsedGitShortstat {
	files: number;
	insertions: number;
	deletions: number;
}

interface GitCommandOutput {
	stdout: string;
	stderr: string;
}

export async function clientQueryGitRepository(ctx: ExtensionContext | undefined, request: ClientGitRepositoryQueryRequest): Promise<ClientGitRepositoryQueryResult> {
	if (!ctx?.cwd) return { text: "Git repository tools unavailable: no active workspace." };
	const cwd = ctx.cwd;
	const status = await queryStatus(cwd);
	if (!status.ok) return { text: status.text };
	if (request.action === "status") return { text: formatGitStatus(status.parsed) };
	if (request.action === "diffstat") return { text: await queryDiffstat(cwd, status.parsed) };
	return { text: "Unsupported Git action." };
}

export function parseGitStatusPorcelain(text: string): ParsedGitStatus {
	const parsed: ParsedGitStatus = { entries: [] };
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		if (line.startsWith("# ")) {
			parseBranchHeader(line.slice(2), parsed);
			continue;
		}
		const entry = parseStatusEntry(line);
		if (entry) parsed.entries.push(entry);
	}
	return parsed;
}

export function formatGitStatus(status: ParsedGitStatus): string {
	const lines = ["Git status", formatBranchLine(status)];
	const tracked = status.entries.filter((entry) => entry.code !== "??");
	const untracked = status.entries.filter((entry) => entry.code === "??");
	if (status.upstream) lines.push(`Upstream: ${status.upstream}${formatAheadBehind(status)}`);
	if (status.entries.length === 0) {
		lines.push(status.warnings?.length ? "State: unknown — bounded Git query incomplete" : "State: clean");
		appendWarnings(lines, status.warnings);
		return lines.join("\n");
	}
	const countPrefix = status.warnings?.length ? "at least " : "";
	const changedLabel = tracked.length === 1 ? "1 changed" : `${tracked.length} changed`;
	const untrackedLabel = untracked.length === 1 ? "1 untracked" : `${untracked.length} untracked`;
	lines.push(`State: dirty — ${countPrefix}${changedLabel}, ${countPrefix}${untrackedLabel}`);
	lines.push("Files:");
	const shownEntries = status.entries.slice(0, MAX_FILE_LINES);
	for (const entry of shownEntries) lines.push(`${entry.code.padEnd(2, " ")} ${entry.path}`);
	if (status.entries.length > shownEntries.length) lines.push(`… ${status.entries.length - shownEntries.length} more`);
	appendWarnings(lines, status.warnings);
	return truncateText(lines.join("\n"));
}

export function parseGitShortstat(text: string): ParsedGitShortstat {
	return {
		files: parseCount(text, /([0-9]+) files? changed/),
		insertions: parseCount(text, /([0-9]+) insertions?\(\+\)/),
		deletions: parseCount(text, /([0-9]+) deletions?\(-\)/),
	};
}

export function formatGitDiffstat(status: ParsedGitStatus, shortstat: ParsedGitShortstat | undefined, warning?: string): string {
	const lines = ["Git diffstat", formatBranchLine(status)];
	if (status.upstream) lines.push(`Upstream: ${status.upstream}${formatAheadBehind(status)}`);
	if (!shortstat) lines.push("Staged diff: unknown");
	else if (shortstat.files === 0 && shortstat.insertions === 0 && shortstat.deletions === 0) lines.push("Staged diff: none");
	else lines.push(`Staged diff: ${shortstat.files} ${shortstat.files === 1 ? "file" : "files"}, +${shortstat.insertions}/-${shortstat.deletions}`);
	const trackedChanged = status.entries.filter((entry) => entry.code !== "??").length;
	const untracked = status.entries.filter((entry) => entry.code === "??").length;
	const statusPrefix = status.warnings?.length ? "at least " : "";
	lines.push(`Status files: ${statusPrefix}${trackedChanged} changed, ${statusPrefix}${untracked} untracked`);
	appendWarnings(lines, [...(status.warnings ?? []), ...(warning ? [warning] : [])]);
	return truncateText(lines.join("\n"));
}

async function queryStatus(cwd: string): Promise<{ ok: true; parsed: ParsedGitStatus } | { ok: false; text: string }> {
	try {
		await runGit(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "rev-parse", "--is-inside-work-tree"]);
	} catch (error) {
		return { ok: false, text: formatGitFailure("Git status", cwd, error) };
	}
	const parsed: ParsedGitStatus = { entries: [] };
	parsed.branch = (await runGitOptional(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "branch", "--show-current"])) || "(detached)";
	parsed.head = await runGitOptional(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "rev-parse", "--short=12", "HEAD"]);
	parsed.upstream = await runGitOptional(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	if (parsed.upstream) {
		const aheadBehind = await runGitOptional(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "rev-list", "--left-right", "--count", `HEAD...${parsed.upstream}`]);
		const match = aheadBehind?.match(/^(\d+)\s+(\d+)$/);
		if (match) {
			parsed.ahead = Number(match[1]);
			parsed.behind = Number(match[2]);
		}
	}
	const safeStatus = await querySafeStatusEntries(cwd, Boolean(parsed.head));
	parsed.entries = safeStatus.entries;
	parsed.warnings = safeStatus.warnings.length > 0 ? safeStatus.warnings : undefined;
	return { ok: true, parsed };
}

async function querySafeStatusEntries(cwd: string, hasHead: boolean): Promise<{ entries: GitStatusEntry[]; warnings: string[] }> {
	const warnings: string[] = [];
	const byPath = new Map<string, { x?: string; y?: string }>();
	for (const entry of parseNameStatus(await querySafeStagedNameStatus(cwd, hasHead, warnings))) {
		byPath.set(entry.path, { x: entry.code });
	}
	const deleted = new Set(splitGitLines(await runGitComponent(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "ls-files", "--deleted", "--exclude-standard"], "deleted-file list", warnings)));
	for (const path of deleted) {
		const entry = byPath.get(path) ?? {};
		entry.y = "D";
		byPath.set(path, entry);
	}
	for (const path of await queryMetadataModifiedPaths(cwd, deleted, warnings)) {
		const entry = byPath.get(path) ?? {};
		entry.y = "M";
		byPath.set(path, entry);
	}
	const entries: GitStatusEntry[] = [...byPath.entries()].map(([path, entry]) => ({ code: `${entry.x ?? " "}${entry.y ?? " "}`, path }));
	for (const path of splitGitLines(await runGitComponent(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "ls-files", "--others", "--exclude-standard"], "untracked-file list", warnings))) {
		entries.push({ code: "??", path });
	}
	return { entries, warnings };
}

async function querySafeStagedNameStatus(cwd: string, hasHead: boolean, warnings: string[]): Promise<string | undefined> {
	const baseArgs = [...READ_ONLY_GIT_GLOBAL_ARGS, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--name-status"];
	if (hasHead) return await runGitComponent(cwd, [...baseArgs, "HEAD", "--"], "staged-file list", warnings);
	return await runGitComponent(cwd, [...baseArgs, "--"], "staged-file list", warnings);
}

async function queryMetadataModifiedPaths(cwd: string, deleted: Set<string>, warnings: string[]): Promise<string[]> {
	const debugText = await runGitComponent(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "ls-files", "--debug"], "tracked-file metadata", warnings);
	const stageText = await runGitComponent(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "ls-files", "--stage"], "tracked-file mode list", warnings);
	if (!debugText) return [];
	const indexModes = parseLsFilesStageModes(stageText);
	const compareFileMode = (await runGitOptional(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "config", "--bool", "core.filemode"])) !== "false";
	const modified: string[] = [];
	for (const entry of parseLsFilesDebug(debugText)) {
		if (deleted.has(entry.path)) continue;
		try {
			const indexMode = indexModes.get(entry.path);
			if (indexMode === "160000") continue;
			const fileStat = await lstat(join(cwd, entry.path));
			const mtimeSeconds = Math.trunc(fileStat.mtimeMs / 1000);
			const worktreeMode = gitModeFromStat(fileStat);
			if (fileStat.size !== entry.size || mtimeSeconds !== entry.mtimeSeconds || (compareFileMode && indexMode !== undefined && worktreeMode !== undefined && indexMode !== worktreeMode)) modified.push(entry.path);
		} catch {
			// Missing files are covered by the deleted-file query; inaccessible files are left unreported rather than executing Git filters.
		}
	}
	warnings.push("Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second.");
	return modified;
}

function parseLsFilesStageModes(text: string | undefined): Map<string, string> {
	const modes = new Map<string, string>();
	for (const line of splitGitLines(text)) {
		const match = line.match(/^(\d{6})\s+[0-9a-fA-F]+\s+\d+\t(.+)$/);
		if (match) modes.set(match[2]!, match[1]!);
	}
	return modes;
}

function gitModeFromStat(fileStat: Awaited<ReturnType<typeof lstat>>): string | undefined {
	if (fileStat.isSymbolicLink()) return "120000";
	if (fileStat.isFile()) return (Number(fileStat.mode) & 0o111) !== 0 ? "100755" : "100644";
	return undefined;
}

function parseLsFilesDebug(text: string): Array<{ path: string; mtimeSeconds: number; size: number }> {
	const entries: Array<{ path: string; mtimeSeconds: number; size: number }> = [];
	let current: { path: string; mtimeSeconds?: number; size?: number } | undefined;
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		if (!line.startsWith(" ") && !line.startsWith("\t")) {
			if (current?.mtimeSeconds !== undefined && current.size !== undefined) entries.push({ path: current.path, mtimeSeconds: current.mtimeSeconds, size: current.size });
			current = { path: line };
			continue;
		}
		if (!current) continue;
		const mtime = line.match(/^\s*mtime:\s*(\d+):/);
		if (mtime) current.mtimeSeconds = Number(mtime[1]);
		const size = line.match(/^\s*size:\s*(\d+)/);
		if (size) current.size = Number(size[1]);
	}
	if (current?.mtimeSeconds !== undefined && current.size !== undefined) entries.push({ path: current.path, mtimeSeconds: current.mtimeSeconds, size: current.size });
	return entries;
}

function parseNameStatus(text: string | undefined): Array<{ code: string; path: string }> {
	const entries: Array<{ code: string; path: string }> = [];
	for (const line of splitGitLines(text)) {
		const parts = line.split("\t");
		const code = parts[0]?.slice(0, 1);
		if (!code) continue;
		const path = parts.length >= 3 && /^[RC]/.test(parts[0]!) ? parts[2] : parts[1];
		if (path) entries.push({ code, path });
	}
	return entries;
}

function splitGitLines(text: string | undefined): string[] {
	return text ? text.split(/\r?\n/).filter((line) => line.length > 0) : [];
}

async function queryDiffstat(cwd: string, status: ParsedGitStatus): Promise<string> {
	try {
		const result = await runGit(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--shortstat", "HEAD", "--"]);
		return formatGitDiffstat(status, parseGitShortstat(result.stdout), safeDiffstatNote(status));
	} catch (error) {
		const message = compactError(error);
		if (/ambiguous argument 'HEAD'|unknown revision|bad revision/i.test(message)) {
			try {
				const result = await runGit(cwd, [...READ_ONLY_GIT_GLOBAL_ARGS, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--shortstat", "--"]);
				return formatGitDiffstat(status, parseGitShortstat(result.stdout), safeDiffstatNote(status));
			} catch (fallbackError) {
				return formatGitDiffstat(status, undefined, compactError(fallbackError));
			}
		}
		return formatGitDiffstat(status, undefined, message);
	}
}

async function runGitOptional(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await runGit(cwd, args);
		return result.stdout || undefined;
	} catch {
		return undefined;
	}
}

async function runGitComponent(cwd: string, args: string[], label: string, warnings: string[]): Promise<string | undefined> {
	try {
		const result = await runGit(cwd, args);
		return result.stdout || undefined;
	} catch (error) {
		warnings.push(`${label} incomplete: ${compactError(error)}`);
		return undefined;
	}
}

function runGit(cwd: string, args: string[]): Promise<GitCommandOutput> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, env: gitEnvironment() }, (error, stdout, stderr) => {
			if (error) {
				reject(Object.assign(error, { stderr, stdout }));
				return;
			}
			resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
		});
	});
}

function gitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_EXTERNAL_DIFF = "";
	return env;
}

function parseBranchHeader(header: string, status: ParsedGitStatus): void {
	const value = header.slice(header.indexOf(" ") + 1).trim();
	if (header.startsWith("branch.oid ")) status.head = value === "(initial)" ? undefined : value.slice(0, 12);
	else if (header.startsWith("branch.head ")) status.branch = value;
	else if (header.startsWith("branch.upstream ")) status.upstream = value;
	else if (header.startsWith("branch.ab ")) {
		const match = value.match(/^\+(-?\d+)\s+-(-?\d+)$/);
		if (match) {
			status.ahead = Number(match[1]);
			status.behind = Number(match[2]);
		}
	}
}

function parseStatusEntry(line: string): GitStatusEntry | undefined {
	if (line.startsWith("? ")) return { code: "??", path: line.slice(2) };
	if (line.startsWith("! ")) return undefined;
	const parts = line.split(" ");
	const kind = parts[0];
	const rawCode = parts[1];
	if (!kind || !rawCode) return undefined;
	if (kind === "1") return { code: normalizeStatusCode(rawCode), path: normalizePath(parts.slice(8).join(" ")) };
	if (kind === "2") return { code: normalizeStatusCode(rawCode), path: normalizePath(parts.slice(9).join(" ").split("\t")[0] ?? "") };
	if (kind === "u") return { code: "UU", path: normalizePath(parts.slice(10).join(" ")) };
	return undefined;
}

function normalizeStatusCode(code: string): string {
	return code.replace(/\./g, " ").padEnd(2, " ").slice(0, 2);
}

function normalizePath(path: string): string {
	return path.trim() || "(unknown)";
}

function formatBranchLine(status: ParsedGitStatus): string {
	const branch = status.branch && status.branch !== "(detached)" ? status.branch : "detached HEAD";
	return `Branch: ${branch}${status.head ? ` @ ${status.head}` : ""}`;
}

function formatAheadBehind(status: ParsedGitStatus): string {
	const ahead = status.ahead ?? 0;
	const behind = status.behind ?? 0;
	return ahead || behind ? ` (+${ahead}/-${behind})` : "";
}

function appendWarnings(lines: string[], warnings: string[] | undefined): void {
	if (!warnings?.length) return;
	for (const warning of warnings.slice(0, 3)) lines.push(`Note: ${warning}`);
	if (warnings.length > 3) lines.push(`Note: ${warnings.length - 3} more warnings omitted.`);
}

function safeDiffstatNote(status: ParsedGitStatus): string | undefined {
	return status.entries.some((entry) => entry.code !== "??" && entry.code[1] && entry.code[1] !== " ") ? "Unstaged line totals are skipped to avoid executing configured Git filter helpers." : undefined;
}

function parseCount(text: string, pattern: RegExp): number {
	const match = text.match(pattern);
	return match ? Number(match[1]) : 0;
}

function formatGitFailure(title: string, cwd: string, error: unknown): string {
	const message = compactError(error);
	if (/not a git repository/i.test(message)) return `${title}\nNot a Git repository: ${cwd}`;
	return `${title}\nGit command failed: ${message}`;
}

function compactError(error: unknown): string {
	const withStreams = error as { stderr?: string; stdout?: string; killed?: boolean; signal?: string; code?: unknown };
	if (withStreams.killed || withStreams.signal === "SIGTERM") return "git command timed out";
	const streamText = [withStreams.stderr, withStreams.stdout].filter(Boolean).join("\n").trim();
	return truncateOneLine(streamText || errorMessage(error));
}

function truncateOneLine(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= 240 ? oneLine : `${oneLine.slice(0, 237)}…`;
}

function truncateText(text: string): string {
	return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 20)}\n… truncated`;
}
