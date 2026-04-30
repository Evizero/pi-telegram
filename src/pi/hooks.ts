import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerActivityMirrorHooks, type PiActivityHookDeps } from "./activity.js";
import { registerTelegramAttachmentTool, type PiAttachmentHookDeps } from "./attachments.js";
import { registerTelegramCommands, type PiCommandHookDeps } from "./commands.js";
import { registerAssistantFinalizationHook, type PiFinalizationHookDeps } from "./finalization.js";
import { registerSessionLifecycleHooks, type PiLifecycleHookDeps } from "./lifecycle.js";
import { registerLocalInputMirrorHook, type PiLocalInputHookDeps } from "./local-input.js";
import { registerPromptSuffixHook } from "./prompt.js";

export type RuntimePiHooksDeps = PiAttachmentHookDeps
	& PiCommandHookDeps
	& PiLocalInputHookDeps
	& PiLifecycleHookDeps
	& PiActivityHookDeps
	& PiFinalizationHookDeps;

// Keep these type exports available for fixtures and callers that still import
// the monolithic hook contract while the implementation is split by concern.
export type { ActiveTelegramTurn, BrokerState, PendingTelegramTurn, QueuedAttachment, TelegramRoute } from "../shared/types.js";
export type { PiActivityHookDeps, PiAttachmentHookDeps, PiCommandHookDeps, PiFinalizationHookDeps, PiLifecycleHookDeps, PiLocalInputHookDeps };

export function registerRuntimePiHooks(pi: ExtensionAPI, deps: RuntimePiHooksDeps): void {
	registerTelegramAttachmentTool(pi, deps);
	registerTelegramCommands(pi, deps);
	registerSessionLifecycleHooks(pi, deps);
	registerLocalInputMirrorHook(pi, deps);
	registerPromptSuffixHook(pi);
	registerActivityMirrorHooks(pi, deps);
	registerAssistantFinalizationHook(pi, deps);
}
