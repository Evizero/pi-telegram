import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface PiDiagnosticEvent {
	message: string;
	severity?: "info" | "warning" | "error";
	notify?: boolean;
}

export interface PiDiagnosticReporterDeps {
	getLatestContext: () => ExtensionContext | undefined;
}

export type PiDiagnosticReporter = (event: PiDiagnosticEvent) => void;

export function createPiDiagnosticReporter(deps: PiDiagnosticReporterDeps): PiDiagnosticReporter {
	return (event) => {
		const ctx = deps.getLatestContext();
		if (ctx && event.notify) ctx.ui.notify(event.message, event.severity === "error" ? "error" : "info");
	};
}
