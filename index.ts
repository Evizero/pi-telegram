import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerTelegramExtension } from "./src/extension.js";

export default function (pi: ExtensionAPI) {
	registerTelegramExtension(pi);
}
