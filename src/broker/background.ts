import { isStaleBrokerError } from "./lease.js";
import { errorMessage } from "../shared/utils.js";

export interface BrokerBackgroundTaskDeps {
	stopBroker: () => Promise<void>;
	log?: (message: string) => void;
}

export async function handleBrokerBackgroundError(label: string, error: unknown, deps: BrokerBackgroundTaskDeps): Promise<void> {
	if (isStaleBrokerError(error)) {
		try {
			await deps.stopBroker();
		} catch (stopError) {
			(deps.log ?? console.warn)(`[pi-telegram] Failed to stop stale broker after ${label}: ${errorMessage(stopError)}`);
		}
		return;
	}
	(deps.log ?? console.warn)(`[pi-telegram] ${label} failed: ${errorMessage(error)}`);
}

export function runBrokerBackgroundTask(label: string, task: () => Promise<void>, deps: BrokerBackgroundTaskDeps): void {
	void task().catch((error) => {
		void handleBrokerBackgroundError(label, error, deps).catch((handlerError) => {
			console.warn(`[pi-telegram] Failed to handle background broker error for ${label}: ${errorMessage(handlerError)}`);
		});
	});
}
