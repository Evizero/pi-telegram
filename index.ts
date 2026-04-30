import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerTelegramBootstrap } from "./src/bootstrap.js";

export default function (pi: ExtensionAPI) {
	registerTelegramBootstrap(pi);
}
