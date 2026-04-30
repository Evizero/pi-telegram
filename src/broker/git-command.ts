import type { ClientGitRepositoryQueryResult, GitRepositoryAction } from "../client/types.js";
import type { TelegramCallbackQuery } from "../telegram/types.js";
import type { BrokerState, SessionRegistration, TelegramGitControlState, TelegramRoute } from "./types.js";
import { errorMessage, now } from "../shared/utils.js";
import { getTelegramRetryAfterMs } from "../telegram/api.js";
import type { TelegramCommandRouterDeps } from "./command-types.js";
import { createGitControlState, parseGitControlCallback, renderGitControlMenu } from "./git-controls.js";
import { answerControlCallback, callbackMatchesControlMessage, controlRouteStillValid, tryEditCallbackMessage, tryEditOrSendControlResult, trySendControlReply } from "./inline-controls.js";

export class TelegramGitCommandHandler {
	constructor(private readonly deps: TelegramCommandRouterDeps) {}

	async handleCommand(route: TelegramRoute): Promise<void> {
		const brokerState = this.deps.getBrokerState();
		const control = createGitControlState(route);
		if (route.routeMode === "single_chat_selector") {
			const selection = brokerState?.selectorSelections?.[String(route.chatId)];
			control.selectorSelectionUpdatedAtMs = selection?.updatedAtMs;
			control.selectorSelectionExpiresAtMs = selection?.expiresAtMs;
		}
		const rendered = renderGitControlMenu(control);
		const messageId = await this.deps.sendTextReply(route.chatId, route.messageThreadId, rendered.text, { replyMarkup: rendered.replyMarkup });
		control.messageId = messageId;
		if (brokerState) {
			brokerState.gitControls ??= {};
			brokerState.gitControls[control.token] = control;
			this.prune(brokerState);
			await this.deps.persistBrokerState();
		}
	}

	async handleCallback(query: TelegramCallbackQuery): Promise<boolean> {
		const brokerState = this.deps.getBrokerState();
		if (!brokerState) return true;
		const callback = parseGitControlCallback(query.data);
		if (!callback) {
			await answerControlCallback(this.deps, query.id, "This Git button is invalid.", true);
			return true;
		}
		const control = brokerState.gitControls?.[callback.token];
		if (!control) {
			await answerControlCallback(this.deps, query.id, "Git menu expired. Send /git again.", true);
			await tryEditCallbackMessage(this.deps, query, "Git menu expired. Send /git again.");
			return true;
		}
		if (!callbackMatchesControlMessage(query, control) || !controlRouteStillValid(brokerState, control, { requireSelectorFreshness: true })) {
			await answerControlCallback(this.deps, query.id, "This Git menu no longer matches the active session. Send /git again.", true);
			return true;
		}
		if (control.expiresAtMs < now()) {
			delete brokerState.gitControls![callback.token];
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, "Git menu expired. Send /git again.", true);
			await tryEditCallbackMessage(this.deps, query, "Git menu expired. Send /git again.");
			return true;
		}
		const session = brokerState.sessions[control.sessionId];
		if (!session || session.status === "offline") {
			delete brokerState.gitControls?.[callback.token];
			await this.deps.persistBrokerState();
			await answerControlCallback(this.deps, query.id, "That pi session is offline. Send /sessions to pick another.", true);
			await tryEditCallbackMessage(this.deps, query, "That pi session is offline. Send /sessions to pick another.");
			return true;
		}
		if (control.completedText) {
			if (control.completedAction && control.completedAction !== callback.action) {
				await answerControlCallback(this.deps, query.id, "Git menu already handled. Send /git again.", true);
				return true;
			}
			return await this.finishCallback(query, control, callback.action);
		}
		control.updatedAtMs = now();
		await this.deps.persistBrokerState();
		let result: ClientGitRepositoryQueryResult;
		try {
			result = await this.queryRepository(session, callback.action);
		} catch (error) {
			await answerControlCallback(this.deps, query.id, "Failed to query Git state.", true);
			await trySendControlReply(this.deps, control.chatId, control.messageThreadId, `Failed to query Git state: ${errorMessage(error)}`);
			return true;
		}
		control.completedText = result.text;
		control.completedAction = callback.action;
		control.updatedAtMs = now();
		await this.deps.persistBrokerState();
		return await this.finishCallback(query, control, callback.action);
	}

	prune(brokerState: BrokerState): boolean {
		let changed = false;
		for (const [token, control] of Object.entries(brokerState.gitControls ?? {})) {
			if (brokerState.sessions[control.sessionId] && control.expiresAtMs > now()) continue;
			delete brokerState.gitControls![token];
			changed = true;
		}
		return changed;
	}

	private async finishCallback(query: TelegramCallbackQuery, control: TelegramGitControlState, action: GitRepositoryAction): Promise<boolean> {
		if (!control.resultDeliveredAtMs) {
			await tryEditOrSendControlResult(this.deps, control, query, control.completedText!);
			control.resultDeliveredAtMs = now();
			control.updatedAtMs = now();
			await this.deps.persistBrokerState();
		}
		await answerControlCallback(this.deps, query.id, action === "status" ? "Git status ready." : "Git diffstat ready.");
		const brokerState = this.deps.getBrokerState();
		if (brokerState?.gitControls?.[control.token]) delete brokerState.gitControls[control.token];
		await this.deps.persistBrokerState();
		return true;
	}

	private async queryRepository(session: SessionRegistration, action: GitRepositoryAction): Promise<ClientGitRepositoryQueryResult> {
		try {
			return await this.deps.postIpc<ClientGitRepositoryQueryResult>(session.clientSocketPath, "query_git_repository", { action }, session.sessionId);
		} catch (error) {
			session.status = "offline";
			await this.deps.persistBrokerState();
			throw error;
		}
	}
}
