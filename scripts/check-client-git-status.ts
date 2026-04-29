import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { clientQueryGitRepository, formatGitDiffstat, formatGitStatus, parseGitShortstat, parseGitStatusPorcelain } from "../src/client/git-status.js";

type GitAction = "status" | "diffstat";

function checkCleanStatusFormatting(): void {
	const parsed = parseGitStatusPorcelain(["# branch.oid abcdef1234567890", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0"].join("\n"));
	assert.equal(parsed.branch, "main");
	assert.equal(parsed.head, "abcdef123456");
	assert.equal(parsed.upstream, "origin/main");
	assert.equal(parsed.entries.length, 0);
	assert.equal(formatGitStatus(parsed), "Git status\nBranch: main @ abcdef123456\nUpstream: origin/main\nState: clean");
}

function checkCleanStatusWithSafetyNoteFormatting(): void {
	const parsed = parseGitStatusPorcelain(["# branch.oid abcdef1234567890", "# branch.head main"].join("\n"));
	parsed.infoNotes = ["Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second."];
	assert.equal(formatGitStatus(parsed), "Git status\nBranch: main @ abcdef123456\nState: clean\nNote: Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second.");
}

function checkStatusWarningMarksUnknown(): void {
	const parsed = parseGitStatusPorcelain(["# branch.oid abcdef1234567890", "# branch.head main"].join("\n"));
	parsed.failureNotes = ["tracked-file metadata incomplete: git command timed out"];
	assert.equal(formatGitStatus(parsed), "Git status\nBranch: main @ abcdef123456\nState: unknown — bounded Git query incomplete\nNote: tracked-file metadata incomplete: git command timed out");
}

function checkDirtyStatusFormatting(): void {
	const parsed = parseGitStatusPorcelain([
		"# branch.oid abcdef1234567890",
		"# branch.head feature/git-tools",
		"# branch.upstream origin/feature/git-tools",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 abc abc src/file.ts",
		"1 M. N... 100644 100644 100644 abc def src/staged.ts",
		"? new file.txt",
	].join("\n"));
	assert.deepEqual(parsed.entries, [
		{ code: " M", path: "src/file.ts" },
		{ code: "M ", path: "src/staged.ts" },
		{ code: "??", path: "new file.txt" },
	]);
	const text = formatGitStatus(parsed);
	assert.equal(text.includes("State: dirty — 2 changed, 1 untracked"), true);
	assert.equal(text.includes("Upstream: origin/feature/git-tools (+2/-1)"), true);
	assert.equal(text.includes(" M src/file.ts"), true);
	assert.equal(text.includes("?? new file.txt"), true);
}

function checkRenameAndConflictParsing(): void {
	const parsed = parseGitStatusPorcelain([
		"# branch.oid abcdef1234567890",
		"# branch.head (detached)",
		"2 R. N... 100644 100644 100644 abc def R100 new-name.ts\told-name.ts",
		"u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts",
	].join("\n"));
	assert.equal(formatGitStatus(parsed).includes("Branch: detached HEAD @ abcdef123456"), true);
	assert.deepEqual(parsed.entries, [
		{ code: "R ", path: "new-name.ts" },
		{ code: "UU", path: "conflict.ts" },
	]);
}

function checkDiffstatFormatting(): void {
	const status = parseGitStatusPorcelain(["# branch.oid abcdef1234567890", "# branch.head main", "1 .M N... 100644 100644 100644 abc abc src/file.ts", "? notes.txt"].join("\n"));
	const shortstat = parseGitShortstat(" 2 files changed, 10 insertions(+), 3 deletions(-)");
	assert.deepEqual(shortstat, { files: 2, insertions: 10, deletions: 3 });
	assert.equal(formatGitDiffstat(status, shortstat, { kind: "info", text: "Unstaged line totals are skipped to avoid executing configured Git filter helpers." }), "Git diffstat\nBranch: main @ abcdef123456\nStaged diff: 2 files, +10/-3\nStatus files: 1 changed, 1 untracked\nNote: Unstaged line totals are skipped to avoid executing configured Git filter helpers.");
}

function checkEmptyDiffstatFormatting(): void {
	const status = parseGitStatusPorcelain("# branch.head main\n? untracked.txt");
	assert.equal(formatGitDiffstat(status, parseGitShortstat("")), "Git diffstat\nBranch: main\nStaged diff: none\nStatus files: 0 changed, 1 untracked");
}

function checkFailedDiffstatFormattingIsUnknown(): void {
	const status = parseGitStatusPorcelain("# branch.head main\n1 M. N... 100644 100644 100644 abc def staged.ts");
	assert.equal(formatGitDiffstat(status, undefined, { kind: "failure", text: "git command timed out" }), "Git diffstat\nBranch: main\nStaged diff: unknown\nStatus files: 1 changed, 0 untracked\nNote: git command timed out");
}

function checkDiffstatFailurePrecedesInformationalNotes(): void {
	const status = parseGitStatusPorcelain("# branch.head main");
	status.failureNotes = ["tracked-file metadata incomplete: git command timed out", "tracked-file mode list incomplete: git command timed out"];
	status.infoNotes = ["Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second."];
	assert.equal(formatGitDiffstat(status, undefined, { kind: "failure", text: "staged diff incomplete: git command timed out" }), "Git diffstat\nBranch: main\nStaged diff: unknown\nStatus files: at least 0 changed, at least 0 untracked\nNote: staged diff incomplete: git command timed out\nNote: tracked-file metadata incomplete: git command timed out\nNote: tracked-file mode list incomplete: git command timed out\nNote: 1 more notes omitted.");
}

function checkInformationalDiffstatNoteFollowsComponentWarnings(): void {
	const status = parseGitStatusPorcelain("# branch.head main");
	status.failureNotes = ["tracked-file metadata incomplete: git command timed out", "tracked-file mode list incomplete: git command timed out", "untracked-file list incomplete: git command timed out"];
	status.infoNotes = ["Unstaged content detection is metadata-only and may miss same-size edits within the same mtime second."];
	assert.equal(formatGitDiffstat(status, parseGitShortstat(""), { kind: "info", text: "Unstaged line totals are skipped to avoid executing configured Git filter helpers." }), "Git diffstat\nBranch: main\nStaged diff: none\nStatus files: at least 0 changed, at least 0 untracked\nNote: tracked-file metadata incomplete: git command timed out\nNote: tracked-file mode list incomplete: git command timed out\nNote: untracked-file list incomplete: git command timed out\nNote: 2 more notes omitted.");
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("GIT_")) continue;
		env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_EDITOR = ":";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: isolatedGitEnvironment(),
	}).trimEnd();
}

function initTestRepo(root: string): void {
	runGit(root, ["init"]);
	runGit(root, ["config", "user.email", "pi-telegram@example.invalid"]);
	runGit(root, ["config", "user.name", "pi Telegram Test"]);
}

async function withTempDir(prefix: string, check: (root: string) => Promise<void> | void): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), prefix));
	try {
		await check(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function withRepo(check: (root: string) => Promise<void> | void): Promise<void> {
	await withTempDir("pi-telegram-git-status-", async (root) => {
		initTestRepo(root);
		await check(root);
	});
}

function writeFixture(root: string, path: string, content: string): void {
	const fullPath = join(root, path);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content, "utf8");
}

function commitAll(root: string, message: string): void {
	runGit(root, ["add", "--all"]);
	runGit(root, ["commit", "--message", message]);
}

async function queryRepository(cwd: string, action: GitAction = "status"): Promise<string> {
	const result = await clientQueryGitRepository({ cwd } as ExtensionContext, { action });
	return result.text;
}

async function checkRealCleanRepositoryStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "tracked\n");
		commitAll(root, "initial");
		const text = await queryRepository(root);
		assert.match(text, /State: clean/);
		assert.doesNotMatch(text, /State: unknown/);
		assert.match(text, /Note: Unstaged content detection is metadata-only/);
	});
}

async function checkRealInitialRepositoryWithoutHead(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "readme.md", "new repo\n");
		const text = await queryRepository(root);
		assert.match(text, /State: dirty/);
		assert.match(text, /1 untracked/);
		assert.match(text, /\?\? readme\.md/);
	});
}

async function checkRealUnstagedAndUntrackedStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "one\n");
		commitAll(root, "initial");
		writeFixture(root, "tracked.txt", "one plus a much longer unstaged edit\n");
		writeFixture(root, "untracked.txt", "new\n");
		const text = await queryRepository(root);
		assert.match(text, /State: dirty — 1 changed, 1 untracked/);
		assert.match(text, / M tracked\.txt/);
		assert.match(text, /\?\? untracked\.txt/);
		assert.match(text, /Note: Unstaged content detection is metadata-only/);
	});
}

async function checkRealStagedAndMixedStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "one\n");
		commitAll(root, "initial");
		writeFixture(root, "tracked.txt", "two staged\n");
		runGit(root, ["add", "tracked.txt"]);
		writeFixture(root, "tracked.txt", "three unstaged after staging\n");
		writeFixture(root, "new-staged.txt", "new staged\n");
		runGit(root, ["add", "new-staged.txt"]);
		const text = await queryRepository(root);
		assert.match(text, /State: dirty — 2 changed, 0 untracked/);
		assert.match(text, /MM tracked\.txt/);
		assert.match(text, /A  new-staged\.txt/);
	});
}

async function checkRealDeletedStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "deleted.txt", "remove me\n");
		commitAll(root, "initial");
		rmSync(join(root, "deleted.txt"));
		const text = await queryRepository(root);
		assert.match(text, /State: dirty — 1 changed, 0 untracked/);
		assert.match(text, / D deleted\.txt/);
	});
}

async function checkRealDetachedHeadStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "tracked\n");
		commitAll(root, "initial");
		runGit(root, ["checkout", "--detach", "HEAD"]);
		const text = await queryRepository(root);
		assert.match(text, /Branch: detached HEAD @ [0-9a-f]{12}/);
	});
}

async function checkRealMergeConflictStatus(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "conflict.txt", "base\n");
		commitAll(root, "initial");
		const baseBranch = runGit(root, ["branch", "--show-current"]);
		runGit(root, ["checkout", "-b", "theirs"]);
		writeFixture(root, "conflict.txt", "theirs\n");
		commitAll(root, "theirs");
		runGit(root, ["checkout", baseBranch]);
		runGit(root, ["checkout", "-b", "ours"]);
		writeFixture(root, "conflict.txt", "ours\n");
		commitAll(root, "ours");
		assert.throws(() => runGit(root, ["merge", "theirs"]));
		const text = await queryRepository(root);
		assert.match(text, /State: dirty/);
		assert.match(text, /conflict\.txt/);
	});
}

async function checkRealUpstreamAheadBehindStatus(): Promise<void> {
	await withTempDir("pi-telegram-git-upstream-", async (parent) => {
		const repo = join(parent, "repo");
		const remote = join(parent, "remote.git");
		const other = join(parent, "other");
		mkdirSync(repo);
		initTestRepo(repo);
		writeFixture(repo, "tracked.txt", "tracked\n");
		commitAll(repo, "initial");
		const branch = runGit(repo, ["branch", "--show-current"]);
		runGit(parent, ["init", "--bare", remote]);
		runGit(remote, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		runGit(repo, ["remote", "add", "origin", remote]);
		runGit(repo, ["push", "--set-upstream", "origin", branch]);
		writeFixture(repo, "local.txt", "local ahead\n");
		commitAll(repo, "local ahead");
		runGit(parent, ["clone", remote, other]);
		runGit(other, ["config", "user.email", "pi-telegram@example.invalid"]);
		runGit(other, ["config", "user.name", "pi Telegram Test"]);
		writeFixture(other, "remote.txt", "remote behind\n");
		commitAll(other, "remote ahead");
		runGit(other, ["push", "origin", branch]);
		runGit(repo, ["fetch", "origin"]);
		const text = await queryRepository(repo);
		assert.match(text, new RegExp(`Upstream: origin/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\+1/-1\\)`));
	});
}

async function checkRealStagedDiffstat(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "one\n");
		commitAll(root, "initial");
		writeFixture(root, "tracked.txt", "two\n");
		runGit(root, ["add", "tracked.txt"]);
		const text = await queryRepository(root, "diffstat");
		assert.match(text, /Staged diff: 1 file, \+1\/-1/);
		assert.match(text, /Status files: 1 changed, 0 untracked/);
	});
}

async function checkRealUnstagedDiffstatSkipsLineTotals(): Promise<void> {
	await withRepo(async (root) => {
		writeFixture(root, "tracked.txt", "one\n");
		commitAll(root, "initial");
		writeFixture(root, "tracked.txt", "one plus unstaged edit\n");
		const text = await queryRepository(root, "diffstat");
		assert.match(text, /Staged diff: none/);
		assert.match(text, /Status files: 1 changed, 0 untracked/);
		assert.match(text, /Note: Unstaged line totals are skipped to avoid executing configured Git filter helpers\./);
	});
}

async function checkRealNonGitStatus(): Promise<void> {
	await withTempDir("pi-telegram-not-git-", async (root) => {
		const text = await queryRepository(root);
		assert.match(text, /Not a Git repository:/);
	});
}

async function main(): Promise<void> {
	checkCleanStatusFormatting();
	checkCleanStatusWithSafetyNoteFormatting();
	checkStatusWarningMarksUnknown();
	checkDirtyStatusFormatting();
	checkRenameAndConflictParsing();
	checkDiffstatFormatting();
	checkEmptyDiffstatFormatting();
	checkFailedDiffstatFormattingIsUnknown();
	checkDiffstatFailurePrecedesInformationalNotes();
	checkInformationalDiffstatNoteFollowsComponentWarnings();
	await checkRealCleanRepositoryStatus();
	await checkRealInitialRepositoryWithoutHead();
	await checkRealUnstagedAndUntrackedStatus();
	await checkRealStagedAndMixedStatus();
	await checkRealDeletedStatus();
	await checkRealDetachedHeadStatus();
	await checkRealMergeConflictStatus();
	await checkRealUpstreamAheadBehindStatus();
	await checkRealStagedDiffstat();
	await checkRealUnstagedDiffstatSkipsLineTotals();
	await checkRealNonGitStatus();
	console.log("Client Git status checks passed");
}

await main();
