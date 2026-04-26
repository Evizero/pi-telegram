import { basename } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { topicNameFor } from "../shared/format.js";
import type { ActiveTelegramTurn, PendingTelegramTurn, SessionRegistration } from "../shared/types.js";
import { execGit, now } from "../shared/utils.js";

export async function collectSessionRegistration(options: {
	ctx: ExtensionContext;
	sessionId: string;
	ownerId: string;
	startedAtMs: number;
	connectionStartedAtMs: number;
	connectionNonce: string;
	clientSocketPath: string;
	piSessionName?: string;
	activeTelegramTurn?: ActiveTelegramTurn;
	queuedTelegramTurns: PendingTelegramTurn[];
	manualCompactionInProgress?: boolean;
}): Promise<SessionRegistration> {
	const { ctx, sessionId, ownerId, startedAtMs, connectionStartedAtMs, connectionNonce, clientSocketPath, piSessionName, activeTelegramTurn, queuedTelegramTurns, manualCompactionInProgress } = options;
	const gitRoot = await execGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	const gitBranch = await execGit(ctx.cwd, ["branch", "--show-current"]);
	const gitHead = await execGit(ctx.cwd, ["rev-parse", "--short", "HEAD"]);
	const projectName = basename(gitRoot ?? ctx.cwd) || "pi-session";
	const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const base = {
		sessionId,
		ownerId,
		pid: process.pid,
		cwd: ctx.cwd,
		projectName,
		gitRoot,
		gitBranch,
		gitHead,
		piSessionName,
		model,
		status: (!ctx.isIdle() || activeTelegramTurn || manualCompactionInProgress ? "busy" : "idle") as SessionRegistration["status"],
		activeTurnId: activeTelegramTurn?.turnId,
		queuedTurnCount: queuedTelegramTurns.length,
		lastHeartbeatMs: now(),
		connectedAtMs: startedAtMs,
		connectionStartedAtMs,
		connectionNonce,
		clientSocketPath,
		topicName: "",
	};
	return { ...base, topicName: topicNameFor(base) };
}
