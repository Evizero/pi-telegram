import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { SYSTEM_PROMPT_SUFFIX } from "../shared/prompt.js";
import { isTelegramPrompt } from "../shared/format.js";

export function registerPromptSuffixHook(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt) ? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.` : SYSTEM_PROMPT_SUFFIX;
		return { systemPrompt: event.systemPrompt + suffix };
	});
}
