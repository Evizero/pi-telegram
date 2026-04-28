import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { TELEGRAM_TEMP_SESSION_ORPHAN_TTL_MS, TEMP_DIR } from "../shared/config.js";
import type { BrokerState } from "../shared/types.js";

export function telegramSessionTempDir(sessionId: string, tempDirRoot = TEMP_DIR): string {
	return join(tempDirRoot, sessionId);
}

function sessionTempFilesStillNeeded(brokerState: BrokerState | undefined, sessionId: string): boolean {
	if (!sessionId) return false;
	if (brokerState?.sessions?.[sessionId]) return true;
	if (Object.values(brokerState?.pendingTurns ?? {}).some((pending) => pending.turn.sessionId === sessionId)) return true;
	if (Object.values(brokerState?.pendingAssistantFinals ?? {}).some((pending) => pending.turn.sessionId === sessionId)) return true;
	return false;
}

export async function cleanupDownloadedTelegramSessionTempDirIfUnused(options: {
	sessionId: string;
	brokerState: BrokerState | undefined;
	tempDirRoot?: string;
}): Promise<boolean> {
	const { sessionId, brokerState, tempDirRoot = TEMP_DIR } = options;
	if (!sessionId || sessionTempFilesStillNeeded(brokerState, sessionId)) return false;
	await rm(telegramSessionTempDir(sessionId, tempDirRoot), { recursive: true, force: true }).catch(() => undefined);
	return true;
}

export async function sweepOrphanedDownloadedTelegramSessionTempDirs(options: {
	brokerState: BrokerState | undefined;
	tempDirRoot?: string;
	ttlMs?: number;
	nowMs?: number;
}): Promise<string[]> {
	const {
		brokerState,
		tempDirRoot = TEMP_DIR,
		ttlMs = TELEGRAM_TEMP_SESSION_ORPHAN_TTL_MS,
		nowMs = Date.now(),
	} = options;
	const entries = await readdir(tempDirRoot, { withFileTypes: true }).catch(() => []);
	const removed: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const sessionId = entry.name;
		if (sessionTempFilesStillNeeded(brokerState, sessionId)) continue;
		const dirPath = telegramSessionTempDir(sessionId, tempDirRoot);
		const dirStat = await stat(dirPath).catch(() => undefined);
		if (!dirStat || nowMs - dirStat.mtimeMs < ttlMs) continue;
		await rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
		removed.push(sessionId);
	}
	return removed;
}
