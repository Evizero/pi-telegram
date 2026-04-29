import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export interface TelegramConfig {
	version?: number;
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	allowedChatId?: number;
	fallbackSupergroupChatId?: number | string;
	lastUpdateId?: number;
	pairingCodeHash?: string;
	pairingCreatedAtMs?: number;
	pairingExpiresAtMs?: number;
	pairingFailedAttempts?: number;
	topicsEnabled?: boolean;
	topicMode?: "auto" | "private_topics" | "forum_supergroup" | "single_chat_selector" | "disabled";
	fallbackMode?: "forum_supergroup" | "single_chat_selector" | "disabled";
}

export interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
	has_topics_enabled?: boolean;
	allows_users_to_create_topics?: boolean;
}

export interface TelegramChat {
	id: number;
	type: string;
	username?: string;
	title?: string;
	is_forum?: boolean;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

export interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramSticker {
	file_id: string;
	emoji?: string;
	file_size?: number;
}

export interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
	fileSize?: number;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	date?: number;
	edit_date?: number;
	is_topic_message?: boolean;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

export interface TelegramInlineKeyboardButton {
	text: string;
	callback_data?: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramCallbackQuery {
	id: string;
	from: TelegramUser;
	message?: TelegramMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface TelegramGetFileResult {
	file_path?: string;
	file_size?: number;
}

export interface TelegramSentMessage {
	message_id: number;
}

export interface TelegramForumTopic {
	message_thread_id: number;
	name: string;
}

export interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

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
}

export type ActiveTelegramTurn = PendingTelegramTurn;

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

export interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	preserveForRetry?: boolean;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

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
	selectedAtMs?: number;
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
}

export type GitRepositoryAction = "status" | "diffstat";

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
	completedAction?: GitRepositoryAction;
	resultDeliveredAtMs?: number;
	createdAtMs: number;
	updatedAtMs: number;
	expiresAtMs: number;
}

export interface ClientGitRepositoryQueryRequest {
	action: GitRepositoryAction;
}

export interface ClientGitRepositoryQueryResult {
	text: string;
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
	assistantPreviewMessages?: Record<string, AssistantPreviewMessageRef>;
	selectorSelections?: Record<string, TelegramSelectorSelection>;
	modelPickers?: Record<string, TelegramModelPickerState>;
	gitControls?: Record<string, TelegramGitControlState>;
	queuedTurnControls?: Record<string, QueuedTurnControlState>;
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

export interface IpcEnvelope<TPayload = unknown> {
	schema_version: 1;
	id: string;
	type: string;
	session_id?: string;
	connection_nonce?: string;
	payload: TPayload;
	sent_at_ms: number;
}

export interface IpcResponse<TPayload = unknown> {
	schema_version: 1;
	id: string;
	ok: boolean;
	payload: TPayload | null;
	error: { code: string; message: string } | null;
	sent_at_ms: number;
}

export interface ModelSummary {
	provider: string;
	id: string;
	name: string;
	input: string[];
	reasoning: boolean;
	label: string;
}
