import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const BASE_BROKER_DIR = join(homedir(), ".pi", "agent", "telegram-broker");
export function baseBrokerDir(): string {
	return BASE_BROKER_DIR;
}

export let BROKER_DIR = BASE_BROKER_DIR;
export let LOCK_DIR = join(BROKER_DIR, "leader.lock");
export let TAKEOVER_LOCK_DIR = join(BROKER_DIR, "takeover.lock");
export let LOCK_PATH = join(LOCK_DIR, "lock.json");
export let STATE_PATH = join(BROKER_DIR, "state.json");
export let TOKEN_PATH = join(BROKER_DIR, "broker-token");
export let DISCONNECT_REQUESTS_DIR = join(BROKER_DIR, "disconnect-requests");
export let SESSION_REPLACEMENT_HANDOFFS_DIR = join(BROKER_DIR, "session-replacement-handoffs");

function applyBrokerDir(baseBrokerDirValue: string, botId?: number): void {
	BROKER_DIR = botId === undefined ? baseBrokerDirValue : join(baseBrokerDirValue, `bot-${botId}`);
	LOCK_DIR = join(BROKER_DIR, "leader.lock");
	TAKEOVER_LOCK_DIR = join(BROKER_DIR, "takeover.lock");
	LOCK_PATH = join(LOCK_DIR, "lock.json");
	STATE_PATH = join(BROKER_DIR, "state.json");
	TOKEN_PATH = join(BROKER_DIR, "broker-token");
	DISCONNECT_REQUESTS_DIR = join(BROKER_DIR, "disconnect-requests");
	SESSION_REPLACEMENT_HANDOFFS_DIR = join(BROKER_DIR, "session-replacement-handoffs");
}

export function configureBrokerScope(botId?: number): void {
	applyBrokerDir(BASE_BROKER_DIR, botId);
}

export function configureBrokerScopeForBase(baseBrokerDirValue: string, botId?: number): void {
	applyBrokerDir(baseBrokerDirValue, botId);
}

export const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
