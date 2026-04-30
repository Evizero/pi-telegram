export type { TelegramConfig } from "../shared/config-types.js";

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

export interface TelegramControlResultDeliveryProgress {
	chunks?: string[];
	mode?: "edited" | "sent";
	deliveredChunkIndexes?: number[];
	deliveredMessageIds?: Record<string, number>;
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
