import assert from "node:assert/strict";

import { TelegramApiError } from "../src/telegram/api.js";
import { createTelegramOutboxRunnerState, drainTelegramOutboxInBroker, enqueueQueuedControlStatusEditJob, queuedControlStatusEditJobId, routeTopicDeleteJobId } from "../src/broker/telegram-outbox.js";
import type { BrokerState, QueuedTurnControlState } from "../src/shared/types.js";
import { state, topicRoute } from "./support/session-route-fixtures.js";

function terminalControl(overrides: Partial<QueuedTurnControlState> = {}): QueuedTurnControlState {
	const route = topicRoute();
	return {
		token: "control-1",
		turnId: "turn-1",
		sessionId: route.sessionId,
		routeId: route.routeId,
		chatId: route.chatId,
		messageThreadId: route.messageThreadId,
		statusMessageId: 70,
		completedText: "Queued follow-up was cleared.",
		status: "expired",
		createdAtMs: Date.now() - 10_000,
		updatedAtMs: Date.now() - 10_000,
		expiresAtMs: Date.now() + 60_000,
		...overrides,
	};
}

async function drain(brokerState: BrokerState, callTelegram: (method: string, body: Record<string, unknown>) => Promise<unknown>, terminalFailures: string[] = []): Promise<void> {
	await drainTelegramOutboxInBroker(createTelegramOutboxRunnerState(), {
		getBrokerState: () => brokerState,
		loadBrokerState: async () => brokerState,
		setBrokerState: () => undefined,
		persistBrokerState: async () => undefined,
		callTelegram: async <TResponse>(method: string, body: Record<string, unknown>) => await callTelegram(method, body) as TResponse,
		logTerminalCleanupFailure: (_route, reason) => { terminalFailures.push(reason); },
	});
}

async function checkQueuedControlEnqueueIsIdempotent(): Promise<void> {
	const control = terminalControl();
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, queuedTurnControls: { [control.token]: control }, telegramOutbox: {} });
	assert.equal(enqueueQueuedControlStatusEditJob(brokerState, control), true);
	assert.equal(enqueueQueuedControlStatusEditJob(brokerState, control), true);
	assert.deepEqual(Object.keys(brokerState.telegramOutbox ?? {}), [queuedControlStatusEditJobId(control.token)]);
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText"]);
	assert.equal(control.statusMessageFinalizedAtMs !== undefined, true);
	assert.equal(brokerState.telegramOutbox?.[queuedControlStatusEditJobId(control.token)]?.status, "completed");
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText"]);
}

async function checkQueuedControlRetryAfterDefersAndResumes(): Promise<void> {
	const control = terminalControl({ token: "retry-control" });
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, queuedTurnControls: { [control.token]: control }, telegramOutbox: {} });
	enqueueQueuedControlStatusEditJob(brokerState, control);
	let fail = true;
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		if (fail) {
			fail = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 3);
		}
		return true;
	});
	const job = brokerState.telegramOutbox?.[queuedControlStatusEditJobId(control.token)];
	assert.equal(job?.status, "pending");
	assert.ok((job?.retryAtMs ?? 0) > Date.now());
	assert.ok((control.statusMessageRetryAtMs ?? 0) > Date.now());
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText"]);
	job!.retryAtMs = Date.now() - 1;
	control.statusMessageRetryAtMs = Date.now() - 1;
	brokerState.queuedTurnControlCleanupRetryAtMs = Date.now() - 1;
	brokerState.telegramOutboxRetryAtMs = Date.now() - 1;
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText", "editMessageText"]);
	assert.equal(control.statusMessageFinalizedAtMs !== undefined, true);
	assert.equal(brokerState.telegramOutbox?.[queuedControlStatusEditJobId(control.token)]?.status, "completed");
}

async function checkLegacyGlobalRetryBarrierMigratesBeforeJobsRun(): Promise<void> {
	const control = terminalControl({ token: "legacy-barrier", statusMessageRetryAtMs: undefined });
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, queuedTurnControls: { [control.token]: control }, queuedTurnControlCleanupRetryAtMs: Date.now() + 60_000, telegramOutbox: undefined });
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, []);
	assert.ok((brokerState.telegramOutboxRetryAtMs ?? 0) > Date.now());
	assert.ok((brokerState.telegramOutbox?.[queuedControlStatusEditJobId(control.token)]?.retryAtMs ?? 0) > Date.now());
}

async function checkNewJobsInheritActiveRetryAfterBarrier(): Promise<void> {
	const firstControl = terminalControl({ token: "barrier-first" });
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, queuedTurnControls: { [firstControl.token]: firstControl }, telegramOutbox: {} });
	enqueueQueuedControlStatusEditJob(brokerState, firstControl);
	let fail = true;
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		if (fail) {
			fail = false;
			throw new TelegramApiError("editMessageText", "Too Many Requests", 429, 3);
		}
		return true;
	});
	const secondControl = terminalControl({ token: "barrier-second", statusMessageId: 71 });
	brokerState.queuedTurnControls![secondControl.token] = secondControl;
	enqueueQueuedControlStatusEditJob(brokerState, secondControl);
	assert.ok((brokerState.telegramOutbox?.[queuedControlStatusEditJobId(secondControl.token)]?.retryAtMs ?? 0) > Date.now());
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText"]);
}

async function checkRouteCleanupWaitsForQueuedControlThenDeletesTopic(): Promise<void> {
	const route = topicRoute();
	const control = terminalControl({ token: "route-control", routeId: route.routeId, sessionId: route.sessionId });
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } }, queuedTurnControls: { [control.token]: control }, telegramOutbox: {} });
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText", "deleteForumTopic"]);
	assert.equal(brokerState.pendingRouteCleanups?.[route.routeId], undefined);
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(route.routeId)]?.status, "completed");
}

async function checkFinishedRouteJobDoesNotSuppressFreshCleanup(): Promise<void> {
	const route = topicRoute();
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } }, telegramOutbox: {} });
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(route.routeId)]?.status, "completed");
	brokerState.pendingRouteCleanups = { [route.routeId]: { route: { ...route, updatedAtMs: Date.now() }, createdAtMs: Date.now(), updatedAtMs: Date.now() } };
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["deleteForumTopic", "deleteForumTopic"]);
	assert.equal(brokerState.pendingRouteCleanups?.[route.routeId], undefined);
}

async function checkPerJobTransientRetryDoesNotBecomeGlobalBarrier(): Promise<void> {
	const firstControl = terminalControl({ token: "per-job-first" });
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, queuedTurnControls: { [firstControl.token]: firstControl }, telegramOutbox: {} });
	enqueueQueuedControlStatusEditJob(brokerState, firstControl);
	let fail = true;
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		if (fail) {
			fail = false;
			throw new TelegramApiError("editMessageText", "Internal Server Error", 500, undefined);
		}
		return true;
	});
	assert.ok((brokerState.queuedTurnControlCleanupRetryAtMs ?? 0) > Date.now());
	assert.equal(brokerState.telegramOutboxRetryAtMs, undefined);
	const secondControl = terminalControl({ token: "per-job-second", statusMessageId: 72 });
	brokerState.queuedTurnControls![secondControl.token] = secondControl;
	enqueueQueuedControlStatusEditJob(brokerState, secondControl);
	await drain(brokerState, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["editMessageText", "editMessageText"]);
	assert.equal(typeof secondControl.statusMessageFinalizedAtMs, "number");
}

async function checkRouteCleanupRetryAfterSurvivesReload(): Promise<void> {
	const route = topicRoute();
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } }, telegramOutbox: {} });
	let fail = true;
	const calls: string[] = [];
	await drain(brokerState, async (method) => {
		calls.push(method);
		if (fail) {
			fail = false;
			throw new TelegramApiError("deleteForumTopic", "Too Many Requests", 429, 3);
		}
		return true;
	});
	const jobId = routeTopicDeleteJobId(route.routeId);
	assert.equal(brokerState.telegramOutbox?.[jobId]?.status, "pending");
	assert.ok((brokerState.telegramOutbox?.[jobId]?.retryAtMs ?? 0) > Date.now());
	const reloaded = JSON.parse(JSON.stringify(brokerState)) as BrokerState;
	await drain(reloaded, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["deleteForumTopic"]);
	reloaded.telegramOutbox![jobId]!.retryAtMs = Date.now() - 1;
	reloaded.telegramOutboxRetryAtMs = Date.now() - 1;
	reloaded.pendingRouteCleanups![route.routeId]!.retryAtMs = Date.now() - 1;
	await drain(reloaded, async (method) => {
		calls.push(method);
		return true;
	});
	assert.deepEqual(calls, ["deleteForumTopic", "deleteForumTopic"]);
	assert.equal(reloaded.pendingRouteCleanups?.[route.routeId], undefined);
	assert.equal(reloaded.telegramOutbox?.[jobId]?.status, "completed");
}

async function checkLegacyCleanupStateMigratesWithoutMovingAssistantFinals(): Promise<void> {
	const route = topicRoute();
	const retryAtMs = Date.now() - 1;
	const control = terminalControl({ token: "legacy-control", statusMessageRetryAtMs: retryAtMs });
	const brokerState = state({ sessions: {}, routes: {}, selectorSelections: {}, pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000, retryAtMs } }, queuedTurnControls: { [control.token]: control }, queuedTurnControlCleanupRetryAtMs: retryAtMs, telegramOutbox: undefined });
	const assistantFinalKeys = Object.keys(brokerState.pendingAssistantFinals ?? {});
	await drain(brokerState, async () => true);
	assert.deepEqual(Object.keys(brokerState.pendingAssistantFinals ?? {}), assistantFinalKeys);
	assert.equal(brokerState.telegramOutbox?.[queuedControlStatusEditJobId(control.token)]?.status, "completed");
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(route.routeId)]?.status, "completed");
}

async function checkTransientRouteFailureDoesNotStarveOtherJobs(): Promise<void> {
	const firstRoute = topicRoute();
	const secondRoute = { ...topicRoute("other-session"), routeId: "chat-1:10", messageThreadId: 10 };
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [firstRoute.routeId]: { route: firstRoute, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 }, [secondRoute.routeId]: { route: secondRoute, createdAtMs: Date.now() - 9_000, updatedAtMs: Date.now() - 9_000 } }, telegramOutbox: {} });
	const calls: number[] = [];
	await drain(brokerState, async (_method, body) => {
		calls.push(body.message_thread_id as number);
		if (body.message_thread_id === 9) throw new TelegramApiError("deleteForumTopic", "Internal Server Error", 500, undefined);
		return true;
	});
	assert.deepEqual(calls, [9, 10]);
	assert.equal(brokerState.pendingRouteCleanups?.[firstRoute.routeId] !== undefined, true);
	assert.equal(brokerState.pendingRouteCleanups?.[secondRoute.routeId], undefined);
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(firstRoute.routeId)]?.status, "pending");
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(secondRoute.routeId)]?.status, "completed");
}

async function checkTerminalTopicCleanupDiagnosticDoesNotBlockOtherJobs(): Promise<void> {
	const route = topicRoute();
	const secondRoute = { ...topicRoute("other-session"), routeId: "chat-1:10", messageThreadId: 10 };
	const brokerState = state({ sessions: {}, routes: {}, pendingTurns: {}, pendingAssistantFinals: {}, assistantPreviewMessages: {}, selectorSelections: {}, pendingRouteCleanups: { [route.routeId]: { route, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 }, [secondRoute.routeId]: { route: secondRoute, createdAtMs: Date.now() - 10_000, updatedAtMs: Date.now() - 10_000 } }, telegramOutbox: {} });
	const terminalFailures: string[] = [];
	await drain(brokerState, async (_method, body) => {
		if (body.message_thread_id === 9) throw new TelegramApiError("deleteForumTopic", "Unauthorized", 401, undefined);
		return true;
	}, terminalFailures);
	assert.equal(terminalFailures.length, 1);
	assert.match(terminalFailures[0] ?? "", /unauthorized/i);
	assert.equal(brokerState.pendingRouteCleanups?.[route.routeId], undefined);
	assert.equal(brokerState.pendingRouteCleanups?.[secondRoute.routeId], undefined);
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(route.routeId)]?.status, "terminal");
	assert.equal(brokerState.telegramOutbox?.[routeTopicDeleteJobId(secondRoute.routeId)]?.status, "completed");
}

await checkQueuedControlEnqueueIsIdempotent();
await checkQueuedControlRetryAfterDefersAndResumes();
await checkLegacyGlobalRetryBarrierMigratesBeforeJobsRun();
await checkNewJobsInheritActiveRetryAfterBarrier();
await checkRouteCleanupWaitsForQueuedControlThenDeletesTopic();
await checkFinishedRouteJobDoesNotSuppressFreshCleanup();
await checkPerJobTransientRetryDoesNotBecomeGlobalBarrier();
await checkRouteCleanupRetryAfterSurvivesReload();
await checkLegacyCleanupStateMigratesWithoutMovingAssistantFinals();
await checkTransientRouteFailureDoesNotStarveOtherJobs();
await checkTerminalTopicCleanupDiagnosticDoesNotBlockOtherJobs();
console.log("Telegram outbox checks passed");
