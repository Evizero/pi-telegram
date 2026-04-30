import type { BrokerState, QueuedTurnControlState, RouteTopicDeleteOutboxJob, TelegramOutboxJob, TelegramOutboxJobKind, TelegramRoute } from "../shared/types.js";
import { now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import {
	isAlreadyDeletedTelegramTopic,
	isTerminalTelegramTopicCleanupError,
	isTransientTelegramMessageEditError,
	telegramErrorText,
} from "../telegram/errors.js";
import { editTelegramTextMessage } from "../telegram/message-ops.js";
import { cleanupTargetsActiveRoute } from "./routes.js";
import { DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS, isTerminalQueuedControlStatus, markQueuedTurnControlExpired, queuedControlBelongsToRoute, QUEUED_CONTROL_TEXT } from "./queued-controls.js";

const DEFAULT_ROUTE_CLEANUP_RETRY_MS = 1_000;
const RETRY_AFTER_GRACE_MS = 250;
const COMPLETED_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface TelegramOutboxRunnerState {
	inFlight: boolean;
}

export interface TelegramOutboxDrainOptions {
	getBrokerState: () => BrokerState | undefined;
	loadBrokerState: () => Promise<BrokerState>;
	setBrokerState: (state: BrokerState) => void;
	persistBrokerState: () => Promise<void>;
	callTelegram: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
	assertCanRun?: () => Promise<void> | void;
	logTerminalCleanupFailure?: (route: TelegramRoute, reason: string) => void;
	jobKinds?: TelegramOutboxJobKind[];
}

interface DueOutboxJob {
	id: string;
	job: TelegramOutboxJob;
}

export function createTelegramOutboxRunnerState(): TelegramOutboxRunnerState {
	return { inFlight: false };
}

export function queuedControlStatusEditJobId(controlToken: string): string {
	return `queued-control-status:${controlToken}`;
}

export function routeTopicDeleteJobId(cleanupId: string): string {
	return `route-topic-delete:${cleanupId}`;
}

function ensureOutbox(brokerState: BrokerState): Record<string, TelegramOutboxJob> {
	brokerState.telegramOutbox ??= {};
	return brokerState.telegramOutbox;
}

function isFinished(job: TelegramOutboxJob | undefined): boolean {
	return job?.status === "completed" || job?.status === "terminal";
}

function earliestRetryAt(values: Array<number | undefined>): number | undefined {
	return values.reduce<number | undefined>((earliest, value) => {
		if (value === undefined) return earliest;
		return earliest === undefined ? value : Math.min(earliest, value);
	}, undefined);
}

function activeOutboxRetryBarrier(brokerState: BrokerState): number | undefined {
	return brokerState.telegramOutboxRetryAtMs !== undefined && brokerState.telegramOutboxRetryAtMs > now()
		? brokerState.telegramOutboxRetryAtMs
		: undefined;
}

function applyRetryBarrier(brokerState: BrokerState, retryAtMs: number | undefined): number | undefined {
	const barrier = activeOutboxRetryBarrier(brokerState);
	if (barrier === undefined) return retryAtMs;
	if (retryAtMs === undefined) return barrier;
	return Math.max(retryAtMs, barrier);
}

function clearExpiredRetryBarrier(brokerState: BrokerState): boolean {
	if (brokerState.telegramOutboxRetryAtMs === undefined || brokerState.telegramOutboxRetryAtMs > now()) return false;
	delete brokerState.telegramOutboxRetryAtMs;
	return true;
}

function updateQueuedControlCleanupRetryAt(brokerState: BrokerState): void {
	const retryAtMs = earliestRetryAt(Object.values(brokerState.telegramOutbox ?? {})
		.filter((job) => job.kind === "queued_control_status_edit" && (job.status === "pending" || job.status === "delivering"))
		.map((job) => job.retryAtMs));
	if (retryAtMs === undefined) delete brokerState.queuedTurnControlCleanupRetryAtMs;
	else brokerState.queuedTurnControlCleanupRetryAtMs = retryAtMs;
}

function retryDelayFor(error: unknown, fallbackMs: number): number {
	const retryAfterMs = getTelegramRetryAfterMs(error);
	return (retryAfterMs ?? fallbackMs) + (retryAfterMs !== undefined ? RETRY_AFTER_GRACE_MS : 0);
}

export function enqueueQueuedControlStatusEditJob(brokerState: BrokerState, control: QueuedTurnControlState, messageId = control.statusMessageId): boolean {
	if (messageId === undefined || control.completedText === undefined || control.statusMessageFinalizedAtMs !== undefined) return false;
	const id = queuedControlStatusEditJobId(control.token);
	const outbox = ensureOutbox(brokerState);
	const existing = outbox[id];
	if (isFinished(existing)) return false;
	const createdAtMs = existing?.createdAtMs ?? now();
	const retryAtMs = applyRetryBarrier(brokerState, control.statusMessageRetryAtMs);
	outbox[id] = {
		id,
		kind: "queued_control_status_edit",
		status: existing?.status === "delivering" ? "delivering" : "pending",
		controlToken: control.token,
		chatId: control.chatId,
		messageThreadId: control.messageThreadId,
		messageId,
		text: control.completedText,
		createdAtMs,
		updatedAtMs: now(),
		retryAtMs,
		attempts: existing?.attempts ?? 0,
	};
	updateQueuedControlCleanupRetryAt(brokerState);
	return true;
}

export function enqueueRouteTopicDeleteJob(brokerState: BrokerState, cleanupId: string, route: TelegramRoute, retryAtMs?: number): boolean {
	if (route.messageThreadId === undefined) return false;
	retryAtMs = applyRetryBarrier(brokerState, retryAtMs);
	const id = routeTopicDeleteJobId(cleanupId);
	const outbox = ensureOutbox(brokerState);
	const existing = outbox[id];
	const createdAtMs = isFinished(existing) ? now() : existing?.createdAtMs ?? now();
	outbox[id] = {
		id,
		kind: "route_topic_delete",
		status: existing?.status === "delivering" ? "delivering" : "pending",
		cleanupId,
		route,
		createdAtMs,
		updatedAtMs: now(),
		retryAtMs,
		attempts: isFinished(existing) ? 0 : existing?.attempts ?? 0,
	};
	return true;
}

export function migrateLegacyTelegramOutboxState(brokerState: BrokerState): boolean {
	let changed = false;
	const hadOutboxJobs = Object.keys(brokerState.telegramOutbox ?? {}).length > 0;
	if (!hadOutboxJobs && brokerState.queuedTurnControlCleanupRetryAtMs !== undefined && brokerState.queuedTurnControlCleanupRetryAtMs > now()) {
		if (brokerState.telegramOutboxRetryAtMs === undefined || brokerState.telegramOutboxRetryAtMs < brokerState.queuedTurnControlCleanupRetryAtMs) {
			brokerState.telegramOutboxRetryAtMs = brokerState.queuedTurnControlCleanupRetryAtMs;
			changed = true;
		}
	}
	for (const control of Object.values(brokerState.queuedTurnControls ?? {})) {
		if (control.statusMessageId === undefined || control.completedText === undefined || control.statusMessageFinalizedAtMs !== undefined) continue;
		if (!isTerminalQueuedControlStatus(control.status)) continue;
		changed = enqueueQueuedControlStatusEditJob(brokerState, control) || changed;
	}
	for (const [cleanupId, cleanup] of Object.entries(brokerState.pendingRouteCleanups ?? {})) {
		changed = enqueueRouteTopicDeleteJob(brokerState, cleanupId, cleanup.route, cleanup.retryAtMs) || changed;
	}
	updateQueuedControlCleanupRetryAt(brokerState);
	return changed;
}

async function ensureBrokerState(options: Pick<TelegramOutboxDrainOptions, "getBrokerState" | "loadBrokerState" | "setBrokerState">): Promise<BrokerState> {
	const existing = options.getBrokerState();
	if (existing) return existing;
	const loaded = await options.loadBrokerState();
	options.setBrokerState(loaded);
	return loaded;
}

function dueJobs(brokerState: BrokerState, jobKinds: Set<TelegramOutboxJobKind> | undefined): DueOutboxJob[] {
	return Object.entries(brokerState.telegramOutbox ?? {})
		.filter(([, job]) => (jobKinds === undefined || jobKinds.has(job.kind)) && (job.status === "pending" || job.status === "delivering") && (job.retryAtMs === undefined || job.retryAtMs <= now()))
		.sort((left, right) => {
			if (left[1].kind !== right[1].kind) return left[1].kind === "queued_control_status_edit" ? -1 : 1;
			return left[1].createdAtMs - right[1].createdAtMs;
		})
		.map(([id, job]) => ({ id, job }));
}

function pruneCompletedOutboxJobs(brokerState: BrokerState): boolean {
	let changed = false;
	const cutoff = now() - COMPLETED_JOB_RETENTION_MS;
	for (const [id, job] of Object.entries(brokerState.telegramOutbox ?? {})) {
		if ((job.status === "completed" || job.status === "terminal") && (job.completedAtMs ?? job.updatedAtMs) < cutoff) {
			delete brokerState.telegramOutbox![id];
			changed = true;
		}
	}
	return changed;
}

function hasPendingQueuedControlFinalizationForRoute(brokerState: BrokerState, route: TelegramRoute): boolean {
	return Object.values(brokerState.queuedTurnControls ?? {}).some((control) => queuedControlBelongsToRoute(control, route)
		&& control.statusMessageId !== undefined
		&& control.completedText !== undefined
		&& control.statusMessageFinalizedAtMs === undefined);
}

function earliestQueuedControlFinalizationRetryForRoute(brokerState: BrokerState, route: TelegramRoute): number | undefined {
	return earliestRetryAt(Object.values(brokerState.telegramOutbox ?? {})
		.flatMap((job) => {
			if (job.kind !== "queued_control_status_edit" || (job.status !== "pending" && job.status !== "delivering")) return [];
			const control = brokerState.queuedTurnControls?.[job.controlToken];
			return control !== undefined && queuedControlBelongsToRoute(control, route) ? [job.retryAtMs ?? now()] : [];
		}));
}

function completeJob(job: TelegramOutboxJob, status: "completed" | "terminal" = "completed", terminalReason?: string): void {
	job.status = status;
	job.retryAtMs = undefined;
	job.terminalReason = terminalReason;
	job.completedAtMs = now();
	job.updatedAtMs = now();
}

function deferJob(job: TelegramOutboxJob, retryAtMs: number): void {
	job.status = "pending";
	job.retryAtMs = retryAtMs;
	job.updatedAtMs = now();
}

function deferPendingJobsForRetryAfter(brokerState: BrokerState, retryAtMs: number): void {
	brokerState.telegramOutboxRetryAtMs = retryAtMs;
	for (const job of Object.values(brokerState.telegramOutbox ?? {})) {
		if (job.status !== "pending" && job.status !== "delivering") continue;
		if (job.retryAtMs !== undefined && job.retryAtMs >= retryAtMs) continue;
		deferJob(job, retryAtMs);
		if (job.kind === "queued_control_status_edit") {
			const control = brokerState.queuedTurnControls?.[job.controlToken];
			if (control && (control.statusMessageRetryAtMs === undefined || control.statusMessageRetryAtMs < retryAtMs)) {
				control.statusMessageRetryAtMs = retryAtMs;
				control.updatedAtMs = now();
			}
		} else {
			const cleanup = brokerState.pendingRouteCleanups?.[job.cleanupId];
			if (cleanup && (cleanup.retryAtMs === undefined || cleanup.retryAtMs < retryAtMs)) {
				cleanup.retryAtMs = retryAtMs;
				cleanup.updatedAtMs = now();
			}
		}
	}
	updateQueuedControlCleanupRetryAt(brokerState);
}

async function processQueuedControlStatusEditJob(options: TelegramOutboxDrainOptions, brokerState: BrokerState, job: Extract<TelegramOutboxJob, { kind: "queued_control_status_edit" }>): Promise<boolean> {
	const control = brokerState.queuedTurnControls?.[job.controlToken];
	if (!control || control.statusMessageFinalizedAtMs !== undefined || control.statusMessageId === undefined || control.completedText === undefined) {
		completeJob(job);
		return true;
	}
	if (control.statusMessageRetryAtMs !== undefined && control.statusMessageRetryAtMs > now()) {
		deferJob(job, control.statusMessageRetryAtMs);
		updateQueuedControlCleanupRetryAt(brokerState);
		return true;
	}
	job.status = "delivering";
	job.attempts += 1;
	job.updatedAtMs = now();
	await options.persistBrokerState();
	await options.assertCanRun?.();
	try {
		await editTelegramTextMessage(options.callTelegram, job.chatId, job.messageId, job.text);
	} catch (error) {
		const retryAfterMs = getTelegramRetryAfterMs(error);
		if (retryAfterMs !== undefined || isTransientTelegramMessageEditError(error)) {
			const retryAtMs = now() + retryDelayFor(error, DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS);
			control.statusMessageRetryAtMs = retryAtMs;
			control.updatedAtMs = now();
			deferJob(job, retryAtMs);
			if (retryAfterMs !== undefined) deferPendingJobsForRetryAfter(brokerState, retryAtMs);
			else updateQueuedControlCleanupRetryAt(brokerState);
			return true;
		}
		control.statusMessageRetryAtMs = undefined;
		control.statusMessageFinalizedAtMs = now();
		control.updatedAtMs = now();
		completeJob(job, "terminal", telegramErrorText(error));
		updateQueuedControlCleanupRetryAt(brokerState);
		return true;
	}
	control.completedText = job.text;
	control.statusMessageRetryAtMs = undefined;
	control.statusMessageFinalizedAtMs = now();
	control.updatedAtMs = now();
	completeJob(job);
	updateQueuedControlCleanupRetryAt(brokerState);
	return true;
}

function deferRouteDeleteForQueuedControls(brokerState: BrokerState, job: RouteTopicDeleteOutboxJob): boolean {
	if (!hasPendingQueuedControlFinalizationForRoute(brokerState, job.route)) return false;
	const retryAtMs = earliestQueuedControlFinalizationRetryForRoute(brokerState, job.route) ?? now() + DEFAULT_QUEUED_CONTROL_EDIT_RETRY_MS;
	deferJob(job, retryAtMs);
	const cleanup = brokerState.pendingRouteCleanups?.[job.cleanupId];
	if (cleanup) {
		cleanup.retryAtMs = retryAtMs;
		cleanup.updatedAtMs = now();
	}
	return true;
}

async function processRouteTopicDeleteJob(options: TelegramOutboxDrainOptions, brokerState: BrokerState, job: RouteTopicDeleteOutboxJob): Promise<boolean> {
	if (cleanupTargetsActiveRoute(brokerState, job.route)) {
		delete brokerState.pendingRouteCleanups?.[job.cleanupId];
		completeJob(job);
		return true;
	}
	if (deferRouteDeleteForQueuedControls(brokerState, job)) return true;
	job.status = "delivering";
	job.attempts += 1;
	job.updatedAtMs = now();
	await options.persistBrokerState();
	await options.assertCanRun?.();
	try {
		await options.callTelegram("deleteForumTopic", { chat_id: job.route.chatId, message_thread_id: job.route.messageThreadId });
	} catch (error) {
		if (isAlreadyDeletedTelegramTopic(error)) {
			delete brokerState.pendingRouteCleanups?.[job.cleanupId];
			completeJob(job);
			return true;
		}
		if (isTerminalTelegramTopicCleanupError(error)) {
			delete brokerState.pendingRouteCleanups?.[job.cleanupId];
			const reason = telegramErrorText(error);
			completeJob(job, "terminal", reason);
			options.logTerminalCleanupFailure?.(job.route, reason);
			return true;
		}
		const retryAfterMs = getTelegramRetryAfterMs(error);
		const retryAtMs = now() + retryDelayFor(error, DEFAULT_ROUTE_CLEANUP_RETRY_MS);
		deferJob(job, retryAtMs);
		const cleanup = brokerState.pendingRouteCleanups?.[job.cleanupId];
		if (cleanup) {
			cleanup.retryAtMs = retryAtMs;
			cleanup.updatedAtMs = now();
		}
		if (retryAfterMs !== undefined) deferPendingJobsForRetryAfter(brokerState, retryAtMs);
		return true;
	}
	delete brokerState.pendingRouteCleanups?.[job.cleanupId];
	completeJob(job);
	return true;
}

async function processJob(options: TelegramOutboxDrainOptions, brokerState: BrokerState, job: TelegramOutboxJob): Promise<boolean> {
	if (job.kind === "queued_control_status_edit") return await processQueuedControlStatusEditJob(options, brokerState, job);
	return await processRouteTopicDeleteJob(options, brokerState, job);
}

export async function drainTelegramOutboxInBroker(runnerState: TelegramOutboxRunnerState, options: TelegramOutboxDrainOptions): Promise<{ ok: true; drained: boolean }> {
	if (runnerState.inFlight) return { ok: true, drained: false };
	runnerState.inFlight = true;
	try {
		const brokerState = await ensureBrokerState(options);
		let changed = clearExpiredRetryBarrier(brokerState);
		changed = migrateLegacyTelegramOutboxState(brokerState) || changed;
		changed = pruneCompletedOutboxJobs(brokerState) || changed;
		if (changed) await options.persistBrokerState();
		const jobKinds = options.jobKinds === undefined ? undefined : new Set(options.jobKinds);
		let drained = false;
		while (true) {
			const next = dueJobs(brokerState, jobKinds)[0];
			if (!next) break;
			drained = await processJob(options, brokerState, next.job) || drained;
			await options.persistBrokerState();
			if (brokerState.telegramOutboxRetryAtMs !== undefined && brokerState.telegramOutboxRetryAtMs > now()) break;
		}
		return { ok: true, drained };
	} finally {
		runnerState.inFlight = false;
	}
}

export function markRouteQueuedControlsForCleanup(brokerState: BrokerState, route: TelegramRoute): QueuedTurnControlState[] {
	const controls: QueuedTurnControlState[] = [];
	for (const control of Object.values(brokerState.queuedTurnControls ?? {})) {
		if (!queuedControlBelongsToRoute(control, route)) continue;
		if (!markQueuedTurnControlExpired(control, QUEUED_CONTROL_TEXT.cleared) && !(control.statusMessageId !== undefined && control.completedText !== undefined && control.statusMessageFinalizedAtMs === undefined)) continue;
		controls.push(control);
		enqueueQueuedControlStatusEditJob(brokerState, control);
	}
	return controls;
}
