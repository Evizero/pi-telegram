export interface TypingLoopController {
	start(turnId: string, chatId: number | string, messageThreadId?: number): void;
	stop(turnId: string): void;
	stopAll(): void;
}

interface TypingLoopState {
	timer?: ReturnType<typeof setInterval>;
	inFlight: boolean;
	abortController?: AbortController;
}

export function createTypingLoopController(
	sendChatAction: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
	intervalMs = 4000,
): TypingLoopController {
	const loops = new Map<string, TypingLoopState>();

	function sendTyping(turnId: string, state: TypingLoopState, chatId: number | string, messageThreadId?: number): void {
		if (state.inFlight || loops.get(turnId) !== state) return;
		state.inFlight = true;
		const abortController = new AbortController();
		state.abortController = abortController;
		const body: Record<string, unknown> = { chat_id: chatId, action: "typing" };
		if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
		void Promise.resolve()
			.then(() => sendChatAction(body, abortController.signal))
			.catch(() => undefined)
			.finally(() => {
				if (state.abortController === abortController) state.abortController = undefined;
				state.inFlight = false;
			});
	}

	function start(turnId: string, chatId: number | string, messageThreadId?: number): void {
		if (loops.has(turnId)) return;
		const state: TypingLoopState = { inFlight: false };
		loops.set(turnId, state);
		sendTyping(turnId, state, chatId, messageThreadId);
		if (!loops.has(turnId)) return;
		state.timer = setInterval(() => sendTyping(turnId, state, chatId, messageThreadId), intervalMs);
	}

	function stop(turnId: string): void {
		const state = loops.get(turnId);
		if (state?.timer) clearInterval(state.timer);
		state?.abortController?.abort();
		loops.delete(turnId);
	}

	function stopAll(): void {
		for (const state of loops.values()) {
			if (state.timer) clearInterval(state.timer);
			state.abortController?.abort();
		}
		loops.clear();
	}

	return { start, stop, stopAll };
}
