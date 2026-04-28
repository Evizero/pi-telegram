import assert from "node:assert/strict";

import { formatGitDiffstat, formatGitStatus, parseGitShortstat, parseGitStatusPorcelain } from "../src/client/git-status.js";

function checkCleanStatusFormatting(): void {
	const parsed = parseGitStatusPorcelain(["# branch.oid abcdef1234567890", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0"].join("\n"));
	assert.equal(parsed.branch, "main");
	assert.equal(parsed.head, "abcdef123456");
	assert.equal(parsed.upstream, "origin/main");
	assert.equal(parsed.entries.length, 0);
	assert.equal(formatGitStatus(parsed), "Git status\nBranch: main @ abcdef123456\nUpstream: origin/main\nState: clean");
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
	assert.equal(formatGitDiffstat(status, shortstat, "Unstaged line totals are skipped to avoid executing configured Git filter helpers."), "Git diffstat\nBranch: main @ abcdef123456\nStaged diff: 2 files, +10/-3\nStatus files: 1 changed, 1 untracked\nNote: Unstaged line totals are skipped to avoid executing configured Git filter helpers.");
}

function checkEmptyDiffstatFormatting(): void {
	const status = parseGitStatusPorcelain("# branch.head main\n? untracked.txt");
	assert.equal(formatGitDiffstat(status, parseGitShortstat("")), "Git diffstat\nBranch: main\nStaged diff: none\nStatus files: 0 changed, 1 untracked");
}

function checkFailedDiffstatFormattingIsUnknown(): void {
	const status = parseGitStatusPorcelain("# branch.head main\n1 M. N... 100644 100644 100644 abc def staged.ts");
	assert.equal(formatGitDiffstat(status, undefined, "git command timed out"), "Git diffstat\nBranch: main\nStaged diff: unknown\nStatus files: 1 changed, 0 untracked\nNote: git command timed out");
}

checkCleanStatusFormatting();
checkDirtyStatusFormatting();
checkRenameAndConflictParsing();
checkDiffstatFormatting();
checkEmptyDiffstatFormatting();
checkFailedDiffstatFormattingIsUnknown();
console.log("Client Git status checks passed");
