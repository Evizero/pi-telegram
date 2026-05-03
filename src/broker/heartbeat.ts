import { errorMessage } from "../shared/utils.js";
import { isBrokerRenewalContentionError, isStaleBrokerError } from "./lease.js";

export const BROKER_RENEWAL_CONTENTION_DIAGNOSTIC_THRESHOLD = 3;

export interface BrokerDiagnosticEvent {
	message: string;
	severity: "info" | "warning" | "error";
	notify?: boolean;
}

export interface BrokerHeartbeatState {
	inFlight: boolean;
	failures: number;
	renewalContentions: number;
	renewalContentionReported: boolean;
}

export function createBrokerHeartbeatState(): BrokerHeartbeatState {
	return { inFlight: false, failures: 0, renewalContentions: 0, renewalContentionReported: false };
}

export interface BrokerHeartbeatDeps {
	renewBrokerLease: () => Promise<void>;
	isBrokerActive: () => Promise<boolean>;
	runMaintenance: () => Promise<void>;
	handleStaleBrokerError: (error: unknown) => Promise<void>;
	stopBroker: () => Promise<void>;
	reportDiagnostic: (event: BrokerDiagnosticEvent) => void;
}

export async function runBrokerHeartbeatCycle(state: BrokerHeartbeatState, deps: BrokerHeartbeatDeps): Promise<void> {
	if (state.inFlight) return;
	state.inFlight = true;
	try {
		await deps.renewBrokerLease();
		if (!(await deps.isBrokerActive())) return;
		await deps.runMaintenance();
		state.failures = 0;
		state.renewalContentions = 0;
		state.renewalContentionReported = false;
	} catch (error) {
		if (isBrokerRenewalContentionError(error)) {
			state.failures = 0;
			state.renewalContentions += 1;
			if (state.renewalContentions >= BROKER_RENEWAL_CONTENTION_DIAGNOSTIC_THRESHOLD && !state.renewalContentionReported) {
				state.renewalContentionReported = true;
				deps.reportDiagnostic({
					message: "Telegram broker heartbeat is seeing repeated lease-renewal contention; the current broker remains active.",
					severity: "warning",
					notify: true,
				});
			}
			return;
		}
		state.renewalContentions = 0;
		state.renewalContentionReported = false;
		if (isStaleBrokerError(error)) {
			await deps.handleStaleBrokerError(error);
			return;
		}
		state.failures += 1;
		const message = `Telegram broker heartbeat failed: ${errorMessage(error)}`;
		deps.reportDiagnostic({
			message,
			severity: state.failures >= 2 ? "error" : "warning",
			notify: state.failures >= 2,
		});
		if (state.failures >= 2) {
			try {
				await deps.stopBroker();
			} catch (stopError) {
				const stopMessage = `Failed to stop broker after heartbeat failure: ${errorMessage(stopError)}`;
				deps.reportDiagnostic({ message: stopMessage, severity: "error", notify: true });
			}
		}
	} finally {
		state.inFlight = false;
	}
}
