import type { AssistantFinalPayload, GitRepositoryAction, ModelSummary, PendingManualCompactionOperation, PendingTelegramTurn, QueuedAttachment } from "../client/types.js";
import type { TelegramControlResultDeliveryProgress, TelegramInlineKeyboardButton, TelegramMessage, TelegramSentMessage, TelegramUpdate } from "../telegram/types.js";

/**
 * Durable broker-owned state for one Telegram queued-follow-up control message.
 * `offered` means the queued turn is still actionable; `converting` and
 * `cancelling` are in-flight client handshakes; `converted`, `cancelled`, and
 * `expired` are terminal control outcomes. Terminal records may keep
 * `completedText` plus visible-message retry/finalization timestamps so stale
 * Telegram buttons can be cleaned up later without becoming execution authority.
 */
export interface QueuedTurnControlState {
	token: string;
	turnId: string;
	sessionId: string;
	routeId?: string;
	chatId: number | string;
	messageThreadId?: number;
	statusMessageId?: number;
	statusMessageFinalizedAtMs?: number;
	statusMessageRetryAtMs?: number;
	targetActiveTurnId?: string;
	completedText?: string;
	status: "offered" | "converting" | "cancelling" | "converted" | "cancelled" | "expired";
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
}

export interface AssistantFinalDeliveryProgress {
	activityCompleted?: boolean;
	typingStopped?: boolean;
	previewDetached?: boolean;
	previewCleared?: boolean;
	previewCleanupDone?: boolean;
	previewCleanupTerminalReason?: string;
	legacyPreviewEditedFinalReset?: boolean;
	previewMode?: "draft" | "message";
	previewMessageId?: number;
	textHash?: string;
	chunks?: string[];
	sentChunkIndexes?: number[];
	sentChunkMessageIds?: Record<string, number>;
	sentAttachmentIndexes?: number[];
}

export interface AssistantPreviewMessageRef {
	chatId: number | string;
	messageThreadId?: number;
	messageId: number;
	updatedAtMs: number;
}

export interface PendingAssistantFinalDelivery extends AssistantFinalPayload {
	status: "pending" | "delivering" | "terminal";
	createdAtMs: number;
	updatedAtMs: number;
	retryAtMs?: number;
	terminalReason?: string;
	progress: AssistantFinalDeliveryProgress;
}

export interface PendingRouteCleanup {
	route: TelegramRoute;
	createdAtMs: number;
	updatedAtMs: number;
	retryAtMs?: number;
}

export type TelegramOutboxJobKind = "queued_control_status_edit" | "route_topic_delete";
export type TelegramOutboxJobStatus = "pending" | "delivering" | "completed" | "terminal";

export interface TelegramOutboxJobBase {
	id: string;
	kind: TelegramOutboxJobKind;
	status: TelegramOutboxJobStatus;
	createdAtMs: number;
	updatedAtMs: number;
	retryAtMs?: number;
	attempts: number;
	terminalReason?: string;
	completedAtMs?: number;
}

export interface QueuedControlStatusEditOutboxJob extends TelegramOutboxJobBase {
	kind: "queued_control_status_edit";
	controlToken: string;
	chatId: number | string;
	messageThreadId?: number;
	messageId: number;
	text: string;
}

export interface RouteTopicDeleteOutboxJob extends TelegramOutboxJobBase {
	kind: "route_topic_delete";
	cleanupId: string;
	route: TelegramRoute;
}

export type TelegramOutboxJob = QueuedControlStatusEditOutboxJob | RouteTopicDeleteOutboxJob;

export interface SessionReplacementRegistrationContext {
	reason: "new" | "resume" | "fork";
	previousSessionFile?: string;
	sessionFile?: string;
}

export interface SessionRegistration {
	sessionId: string;
	ownerId: string;
	pid: number;
	cwd: string;
	projectName: string;
	gitBranch?: string;
	gitRoot?: string;
	gitHead?: string;
	piSessionName?: string;
	model?: string;
	status: "connecting" | "idle" | "busy" | "offline" | "error";
	activeTurnId?: string;
	queuedTurnCount: number;
	lastHeartbeatMs: number;
	connectedAtMs: number;
	connectionStartedAtMs: number;
	connectionNonce: string;
	staleStandDownConnectionNonce?: string;
	staleStandDownRequestedAtMs?: number;
	reconnectGraceStartedAtMs?: number;
	clientSocketPath: string;
	topicName: string;
	replacement?: SessionReplacementRegistrationContext;
}

export interface TelegramRoute {
	routeId: string;
	sessionId: string;
	chatId: number | string;
	messageThreadId?: number;
	routeMode: "private_topic" | "forum_supergroup_topic" | "single_chat_selector";
	topicName: string;
	createdAtMs: number;
	updatedAtMs: number;
}

export interface TelegramSelectorSelection {
	chatId: number | string;
	sessionId: string;
	expiresAtMs: number;
	updatedAtMs: number;
}

export interface TelegramModelPickerGroup {
	provider: string;
	label: string;
	modelIndexes: number[];
}

export interface TelegramModelPickerState {
	token: string;
	sessionId: string;
	routeId: string;
	chatId: number | string;
	messageThreadId?: number;
	messageId?: number;
	selectorSelectionUpdatedAtMs?: number;
	selectorSelectionExpiresAtMs?: number;
	current?: string;
	models: ModelSummary[];
	groups: TelegramModelPickerGroup[];
	completedText?: string;
	resultDeliveryProgress?: TelegramControlResultDeliveryProgress;
	selectedAtMs?: number;
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
}

export interface TelegramGitControlState {
	token: string;
	sessionId: string;
	routeId: string;
	chatId: number | string;
	messageThreadId?: number;
	messageId?: number;
	selectorSelectionUpdatedAtMs?: number;
	selectorSelectionExpiresAtMs?: number;
	completedText?: string;
	resultDeliveryProgress?: TelegramControlResultDeliveryProgress;
	completedAction?: GitRepositoryAction;
	resultDeliveredAtMs?: number;
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
}

export interface BrokerState {
	schemaVersion: number;
	lastProcessedUpdateId?: number;
	recentUpdateIds: number[];
	sessions: Record<string, SessionRegistration>;
	routes: Record<string, TelegramRoute>;
	pendingMediaGroups?: Record<string, { updates: TelegramUpdate[]; updatedAtMs: number }>;
	pendingTurns?: Record<string, { turn: PendingTelegramTurn; updatedAtMs: number }>;
	pendingAssistantFinals?: Record<string, PendingAssistantFinalDelivery>;
	pendingRouteCleanups?: Record<string, PendingRouteCleanup>;
	telegramOutbox?: Record<string, TelegramOutboxJob>;
	telegramOutboxRetryAtMs?: number;
	assistantPreviewMessages?: Record<string, AssistantPreviewMessageRef>;
	selectorSelections?: Record<string, TelegramSelectorSelection>;
	modelPickers?: Record<string, TelegramModelPickerState>;
	gitControls?: Record<string, TelegramGitControlState>;
	queuedTurnControls?: Record<string, QueuedTurnControlState>;
	pendingManualCompactions?: Record<string, PendingManualCompactionOperation>;
	/** Earliest broker-wide retry time for deferred queued-control status-message cleanup edits. */
	queuedTurnControlCleanupRetryAtMs?: number;
	completedTurnIds?: string[];
	createdAtMs: number;
	updatedAtMs: number;
}

export interface BrokerLease {
	schemaVersion: number;
	ownerId: string;
	pid: number;
	startedAtMs: number;
	leaseEpoch: number;
	socketPath: string;
	leaseUntilMs: number;
	updatedAtMs: number;
	botId?: number;
}
