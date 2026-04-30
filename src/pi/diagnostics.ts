import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PiDiagnosticEvent {
	message: string;
	severity?: "info" | "warning" | "error";
	statusDetail?: string;
	notify?: boolean;
	display?: boolean;
	customType?: string;
}

export interface PiDiagnosticReporterDeps {
	pi: ExtensionAPI;
	getLatestContext: () => ExtensionContext | undefined;
	updateStatus: (ctx: ExtensionContext, detail?: string) => void;
}

export type PiDiagnosticReporter = (event: PiDiagnosticEvent) => void;

export function createPiDiagnosticReporter(deps: PiDiagnosticReporterDeps): PiDiagnosticReporter {
	return (event) => {
		const ctx = deps.getLatestContext();
		if (ctx && event.statusDetail !== undefined) deps.updateStatus(ctx, event.statusDetail);
		if (ctx && event.notify) ctx.ui.notify(event.message, event.severity === "error" ? "error" : "info");
		if (event.display) {
			deps.pi.sendMessage({ customType: event.customType ?? "telegram_diagnostic", content: event.message, display: true }, { triggerTurn: false });
		}
	};
}
