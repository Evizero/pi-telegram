import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { resolveAllowedAttachmentPath } from "../src/client/attachment-path.js";
import { writeJson } from "../src/shared/utils.js";
import type { PendingTelegramTurn, TelegramConfig } from "../src/shared/types.js";
import { promptForTelegramConfig } from "../src/telegram/setup.js";
import { sendQueuedAttachment } from "../src/telegram/attachments.js";
import { TelegramApiError } from "../src/telegram/api.js";

async function checkWriteJsonCreatesPrivateFilesAndUsesPrivateCreateMode(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-security-"));
	try {
		const target = join(root, "token.json");
		await writeJson(target, { bot_token: "secret" });
		assert.equal((await stat(target)).mode & 0o777, 0o600);
		const source = await readFile(join(process.cwd(), "src", "shared", "utils.ts"), "utf8");
		assert.match(source, /mode:\s*0o600/);
		assert.match(source, /flag:\s*"wx"/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function checkOutboundAttachmentSecretPathGuard(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-attachments-"));
	try {
		const safe = join(root, "artifact.txt");
		await writeFile(safe, "ok", "utf8");
		assert.equal(await resolveAllowedAttachmentPath(safe, root), await realpath(safe));
		const blocked = [
			join(root, ".env"),
			join(root, ".env.local"),
			join(root, "id_rsa"),
			join(root, "id_ed25519"),
			join(root, ".ssh", "config"),
			join(root, ".aws", "credentials"),
			join(root, ".azure", "accessTokens.json"),
			join(root, ".config", "gcloud", "application_default_credentials.json"),
			join(root, ".kube", "config"),
			join(root, "application_default_credentials.json"),
		];
		for (const file of blocked) {
			await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
			await writeFile(file, "secret", "utf8");
			assert.equal(await resolveAllowedAttachmentPath(file, root), undefined, file);
		}
		const outside = await mkdtemp(join(tmpdir(), "pi-telegram-secret-outside-"));
		const outsideSecretDir = join(outside, ".kube");
		await mkdir(outsideSecretDir, { recursive: true });
		const outsideSecret = join(outsideSecretDir, "config");
		await writeFile(outsideSecret, "secret", "utf8");
		const link = join(root, "linked-kube-config");
		await symlink(outsideSecret, link);
		assert.equal((await lstat(link)).isSymbolicLink(), true);
		assert.equal(await resolveAllowedAttachmentPath(link, root), undefined);
		await rm(outside, { recursive: true, force: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function mockCtx(token: string): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			input: async () => token,
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionContext;
}

const notifications: Array<{ message: string; level: string }> = [];

function response(data: unknown): Response {
	return { json: async () => data } as Response;
}

async function withImmediateTimers<T>(run: () => Promise<T>): Promise<T> {
	const originalSetTimeout = globalThis.setTimeout;
	(globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
		queueMicrotask(() => {
			if (typeof handler === "function") handler(...args as []);
		});
		return 0 as unknown as NodeJS.Timeout;
	}) as unknown as typeof setTimeout;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
}

async function checkSetupUsesPostRetryAwareGetMe(): Promise<void> {
	const originalFetch = globalThis.fetch;
	try {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		let savedConfig: TelegramConfig | undefined;
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return response({ ok: true, result: { id: 42, is_bot: true, first_name: "Bot", username: "test_bot", has_topics_enabled: true } });
		}) as typeof fetch;
		const configured = await promptForTelegramConfig(mockCtx("123:ABC"), {}, {
			setupInProgress: false,
			configureBrokerScope: () => undefined,
			writeConfig: async (config) => { savedConfig = config; },
			showTelegramStatus: () => undefined,
			showPairingInstructions: () => undefined,
			setSetupInProgress: () => undefined,
			setConfig: () => undefined,
		});
		assert.equal(configured, true);
		assert.equal(calls[0]?.init?.method, "POST");
		assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
		assert.equal(calls[0]?.init?.body, "{}");
		assert.equal((savedConfig as TelegramConfig | undefined)?.botId, 42);

		notifications.length = 0;
		savedConfig = undefined;
		globalThis.fetch = (async () => response({ ok: false, description: "Unauthorized", error_code: 401 })) as typeof fetch;
		const invalid = await promptForTelegramConfig(mockCtx("bad-token"), {}, {
			setupInProgress: false,
			configureBrokerScope: () => undefined,
			writeConfig: async (config) => { savedConfig = config; },
			showTelegramStatus: () => undefined,
			showPairingInstructions: () => undefined,
			setSetupInProgress: () => undefined,
			setConfig: () => undefined,
		});
		assert.equal(invalid, false);
		assert.equal(savedConfig, undefined);
		assert.deepEqual(notifications.at(-1), { message: "Unauthorized", level: "error" });

		let attempts = 0;
		globalThis.fetch = (async () => {
			attempts += 1;
			if (attempts === 1) return response({ ok: false, description: "Too Many Requests", error_code: 429, parameters: { retry_after: 0 } });
			return response({ ok: true, result: { id: 99, is_bot: true, first_name: "Bot", username: "retry_bot" } });
		}) as typeof fetch;
		await withImmediateTimers(async () => {
			const retryConfigured = await promptForTelegramConfig(mockCtx("retry-token"), {}, {
				setupInProgress: false,
				configureBrokerScope: () => undefined,
				writeConfig: async (config) => { savedConfig = config; },
				showTelegramStatus: () => undefined,
				showPairingInstructions: () => undefined,
				setSetupInProgress: () => undefined,
				setConfig: () => undefined,
			});
			assert.equal(retryConfigured, true);
		});
		assert.equal(attempts, 2);
		assert.equal((savedConfig as TelegramConfig | undefined)?.botId, 99);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

function attachmentTurn(): PendingTelegramTurn {
	return { turnId: "turn-1", sessionId: "s1", chatId: 123, messageThreadId: 9, replyToMessageId: 1, queuedAttachments: [], content: [], historyText: "" };
}

async function checkSendPhotoFallbackClassifier(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-telegram-photo-"));
	try {
		const photo = join(root, "photo.jpg");
		await writeFile(photo, "jpeg-ish", "utf8");
		const calls: string[] = [];
		const failures: string[] = [];
		await sendQueuedAttachment({
			turn: attachmentTurn(),
			attachment: { path: photo, fileName: "photo.jpg" },
			callTelegramMultipart: async <TResponse>(method: string): Promise<TResponse> => {
				calls.push(method);
				if (method === "sendPhoto") throw new TelegramApiError("sendPhoto", "Bad Request: IMAGE_PROCESS_FAILED", 400, undefined);
				return { message_id: 1 } as TResponse;
			},
			sendTextReply: async (_chatId, _threadId, text) => { (failures as string[]).push(text); return undefined; },
		});
		assert.deepEqual(calls, ["sendPhoto", "sendDocument"]);
		assert.deepEqual(failures, []);

		calls.length = 0;
		failures.length = 0;
		await sendQueuedAttachment({
			turn: attachmentTurn(),
			attachment: { path: photo, fileName: "photo.jpg" },
			callTelegramMultipart: async <TResponse>(method: string): Promise<TResponse> => {
				calls.push(method);
				throw new TelegramApiError("sendPhoto", "Bad Request: message thread not found", 400, undefined);
			},
			sendTextReply: async (_chatId, _threadId, text) => { (failures as string[]).push(text); return undefined; },
		});
		assert.deepEqual(calls, ["sendPhoto"]);
		assert.match(failures[0] ?? "", /message thread not found/);

		calls.length = 0;
		failures.length = 0;
		await sendQueuedAttachment({
			turn: attachmentTurn(),
			attachment: { path: photo, fileName: "photo.jpg" },
			callTelegramMultipart: async <TResponse>(method: string): Promise<TResponse> => {
				calls.push(method);
				throw new TelegramApiError("sendPhoto", "Bad Request: not enough rights to send photos to the chat", 400, undefined);
			},
			sendTextReply: async (_chatId, _threadId, text) => { (failures as string[]).push(text); return undefined; },
		});
		assert.deepEqual(calls, ["sendPhoto"]);
		assert.match(failures[0] ?? "", /not enough rights/);

		calls.length = 0;
		failures.length = 0;
		await assert.rejects(() => sendQueuedAttachment({
			turn: attachmentTurn(),
			attachment: { path: photo, fileName: "photo.jpg" },
			callTelegramMultipart: async <TResponse>(method: string): Promise<TResponse> => {
				calls.push(method);
				throw new TelegramApiError("sendPhoto", "Too Many Requests", 429, 1);
			},
			sendTextReply: async (_chatId, _threadId, text) => { (failures as string[]).push(text); return undefined; },
		}), /Too Many Requests/);
		assert.deepEqual(calls, ["sendPhoto"]);
		assert.deepEqual(failures, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await checkWriteJsonCreatesPrivateFilesAndUsesPrivateCreateMode();
await checkOutboundAttachmentSecretPathGuard();
await checkSetupUsesPostRetryAwareGetMe();
await checkSendPhotoFallbackClassifier();
console.log("Security, setup, and attachment checks passed");
