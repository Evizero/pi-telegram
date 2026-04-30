import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export interface QueuedAttachment {
	path: string;
	fileName: string;
}

export interface PendingTelegramTurn {
	turnId: string;
	sessionId: string;
	routeId?: string;
	chatId: number | string;
	messageThreadId?: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
	deliveryMode?: "steer" | "followUp";
	blockedByManualCompactionOperationId?: string;
}

export type ActiveTelegramTurn = PendingTelegramTurn;

export interface PendingManualCompactionOperation {
	operationId: string;
	sessionId: string;
	routeId?: string;
	chatId: number | string;
	messageThreadId?: number;
	commandMessageId?: number;
	status: "queued" | "running";
	createdAtMs: number;
	updatedAtMs: number;
}

export interface ClientManualCompactionRequest {
	operation: PendingManualCompactionOperation;
}

export interface ClientManualCompactionResult {
	status: "started" | "queued" | "already_queued" | "already_running" | "already_handled" | "failed" | "unavailable";
	text: string;
	operationId: string;
}

export interface ClientDeliverTurnResult {
	accepted: true;
	disposition: "duplicate" | "completed" | "queued" | "started" | "steered";
	queuedControl?: {
		canSteer: boolean;
		targetActiveTurnId?: string;
	};
}

export interface ConvertQueuedTurnToSteerRequest {
	turnId: string;
	targetActiveTurnId?: string;
}

export interface ConvertQueuedTurnToSteerResult {
	status: "converted" | "already_handled" | "not_found" | "stale";
	text: string;
	turnId: string;
}

export interface CancelQueuedTurnRequest {
	turnId: string;
}

export interface CancelQueuedTurnResult {
	status: "cancelled" | "already_handled" | "not_found" | "stale";
	text: string;
	turnId: string;
}

export interface AssistantFinalPayload {
	turn: PendingTelegramTurn;
	text?: string;
	stopReason?: string;
	errorMessage?: string;
	attachments: QueuedAttachment[];
}

export type GitRepositoryAction = "status" | "diffstat";

export interface ClientGitRepositoryQueryRequest {
	action: GitRepositoryAction;
}

export interface ClientGitRepositoryQueryResult {
	text: string;
}

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
	label: string;
}
