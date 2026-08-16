/**
 * dsh-notify-bell — turn 跟踪模块（v0.11.1：strict final-answer completion）。
 *
 * 职责单一：维护主会话每个 turn 的状态 —— turn/start 起始时间、首条
 * 真实用户消息、assistant/message 与 tool/call 的顺序 —— 并在
 * turn/end(reason.completed) 时判断是否存在“最终 assistant 文本回答”，
 * 只有满足严格判定才产出 complete 语义事件。
 * 不负责输出/播放/去重（那是 index.js 的职责）。
 *
 * 事件链（已从 DSH 源码确认，dsh-agent-loop/lib/index.js）：
 * turn/start → [step 循环: assistant/chunk → assistant/message →
 * tool/call → approval/asked …] → turn/end
 * - turn/end 的 data.reason.kind === "completed" 只表示物理 turn
 * 平衡关闭；空 claim no-op 与工具 concludesTurn 路径也会产生
 * completed，但二者没有最终 assistant 文本回答，不得通知。
 * - 子代理也产生 turn/end，但它们的 session header 的
 * delegationDepth >= 1 —— 只有主会话（undefined 或 0）才通知。
 *
 * 时间轴以事件自身 event.time 为准（replay / 重放安全），不用 Date.now()。
 */
export function createTurnTracker(options = {}) {
	/**
	 * 是否主会话。注意：DSH 中**活的**主会话 header 通常没有
	 * delegationDepth 字段（dsh-host-apiproxy 创建主会话的 meta 只有
	 * {cwd, agentPreset}，dsh-session prepare() 只在 meta 提供时才写入），
	 * 只有经 JSONL 持久化重启恢复的会话才有 0；子代理的
	 * delegationDepth >= 1。因此用 `?? 0` 判主会话（与 dsh-subagent
	 * 的 delegationDepthOf 惯例一致）——undefined 视为主会话，>=1 排除。
	 */
	const isMainSession = options.isMainSession ??
		((session) => (session?.header?.delegationDepth ?? 0) === 0);

	/** `${sessionId}:${turn}` → turn 状态。 */
	const turns = new Map();

	/** sessionId → 已消费的最大 turn 号（任何 reason 的 turn/end 都算，防完整重放）。 */
	const endedTurns = new Map();

	/**
	 * 当前打开的 turn（sessionId → turn）。user/message 事件本身不带
	 * turn 字段（append 的就是 message 本体，见 dsh-agent-loop
	 * session.append("user/message", message)），只能按"最近一次
	 * turn/start"归属。assistant/message 与 tool/call 自带
	 * event.data.turn，必须按该字段精确归属，不得复用 currentTurns。
	 */
	const currentTurns = new Map();

	/** 事件顺序戳：优先用 DSH event.seq，回退到观察顺序（重放/测试事件可能没有 seq）。 */
	let eventOrder = 0;
	const stampEvent = (event) => {
		eventOrder += 1;
		return {
			order: eventOrder,
			seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
			time: typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : null
		};
	};

	/** a 是否晚于 b（同 turn 内比较；seq 优先，观察顺序兜底）。 */
	const isAfter = (a, b) => {
		if (!a || !b) return false;
		if (a.seq !== null && b.seq !== null && a.seq !== b.seq) return a.seq > b.seq;
		return a.order > b.order;
	};

	/** 获取或创建 `${sessionId}:${turn}` 状态。 */
	const ensureTurnEntry = (session, turn) => {
		const sessionId = session?.id ?? 'unknown';
		const key = `${sessionId}:${turn}`;
		let entry = turns.get(key);
		if (!entry) {
			entry = {
				startTime: null,
				firstUserMessage: null,
				/** 最后一个 assistant/message（含是否 text / tool-call 的精确载荷判定）。 */
				lastAssistantMessage: null,
				lastAssistantMessageTime: null,
				/** 最后一个 tool/call（用于“最终文本之后不得再有 tool/call”判定）。 */
				lastToolCall: null,
				lastToolCallTime: null,
				notified: false
			};
			turns.set(key, entry);
		}
		return { sessionId, key, entry };
	};

	/** 提取真实用户输入文本（只认 source.kind === 'user'，排除系统注入）。 */
	const extractUserText = (event) => {
		const data = event?.data ?? {};
		if (data.source?.kind !== 'user') return null;
		const text = (Array.isArray(data.content) ? data.content : [])
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join(' ') // 多 text 块以空格分隔，避免粘连
			.replace(/\s+/g, ' ') // 多行/空白 → 单行空格
			.trim();
		return text.length > 0 ? text : null;
	};

	/**
	 * 检查 DSH assistant/message 的真实载荷：
	 * event.data.message.content 是 block 数组；只有存在非空 text block
	 * 才算“文本回答”，tool-call-only 不能算最终回答。
	 */
	const describeAssistantMessage = (event) => {
		const message = event?.data?.message ?? {};
		const content = Array.isArray(message.content) ? message.content : [];
		let hasText = false;
		let hasToolCall = false;
		for (const block of content) {
			if (!block || typeof block !== 'object') continue;
			if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) hasText = true;
			if (block.type === 'tool-call') hasToolCall = true;
		}
		return { hasText, hasToolCall };
	};

	/**
	 * turn/start：记录起始时间（event.time）并置为当前 turn。
	 * 非主会话不跟踪（不占内存）。
	 */
	const onTurnStart = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!Number.isInteger(turn)) return;
		const { sessionId, entry } = ensureTurnEntry(session, turn);
		currentTurns.set(sessionId, turn);
		entry.startTime = stampEvent(event).time;
	};

	/**
	 * user/message：记录当前 turn 的首条真实用户输入
	 * （source.kind === 'user'，排除系统注入快照）。
	 * 之后的 user/message 不覆盖首条；无当前 turn（先于 turn/start）
	 * 时丢弃。goal-round 的 source.kind === 'goal' 不是 user，不会
	 * 写入摘要，但也不作为最终回答门控。
	 */
	const onUserMessage = (session, event) => {
		if (!isMainSession(session)) return;
		const sessionId = session?.id ?? 'unknown';
		const turn = currentTurns.get(sessionId);
		if (!Number.isInteger(turn)) return;
		const entry = turns.get(`${sessionId}:${turn}`);
		if (!entry || entry.firstUserMessage !== null) return;
		const text = extractUserText(event);
		if (text !== null) entry.firstUserMessage = text;
	};

	/**
	 * assistant/message：按 event.data.turn 精确归属；记录最后一个
	 * assistant/message 的载荷形状（hasText / hasToolCall）。
	 * 缺 turn/start（插件中途加载）时也创建 entry，以便 turn/end 仍能
	 * 识别“有最终文本回答但 duration 未知”的合法日志场景。
	 */
	const onAssistantMessage = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!Number.isInteger(turn)) return;
		const { entry } = ensureTurnEntry(session, turn);
		const { hasText, hasToolCall } = describeAssistantMessage(event);
		const stamp = stampEvent(event);
		entry.lastAssistantMessage = {
			order: stamp.order,
			seq: stamp.seq,
			time: stamp.time,
			hasText,
			hasToolCall
		};
		entry.lastAssistantMessageTime = stamp.time;
	};

	/**
	 * tool/call：按 event.data.turn 精确归属；记录最后一个 tool/call
	 * 的位置，供 turn/end 判断“最终文本之后没有新的 tool/call”。
	 */
	const onToolCall = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (!Number.isInteger(turn)) return;
		const { entry } = ensureTurnEntry(session, turn);
		const stamp = stampEvent(event);
		entry.lastToolCall = {
			order: stamp.order,
			seq: stamp.seq,
			time: stamp.time
		};
		entry.lastToolCallTime = stamp.time;
	};

	/**
	 * turn/end：严格 complete 判定。
	 * 必须同时满足：
	 *   - reason.kind === 'completed'
	 *   - 最后一个 assistant/message 包含非空 text block
	 *   - 该最后一个 assistant/message 不是 tool-call-only（text+tool-call
	 *     混合也不是最终回答）
	 *   - 该 assistant/message 之后没有新的 tool/call
	 * 任一不满足 → 不产出 complete（消费/清理状态后静默）。
	 * 状态一次性消费：无论 reason 如何都清理 currentTurns 与 entry。
	 */
	const onTurnEnd = (session, event) => {
		if (!event || event.type !== 'turn/end') return null;
		if (!isMainSession(session)) return null;
		const data = event?.data ?? {};
		const turn = data.turn;
		if (!Number.isInteger(turn)) return null;
		const sessionId = session?.id ?? 'unknown';
		const lastEnded = endedTurns.get(sessionId);
		const alreadyEnded = typeof lastEnded === 'number' && turn <= lastEnded;
		if (!alreadyEnded) endedTurns.set(sessionId, turn);
		if (currentTurns.get(sessionId) === turn) currentTurns.delete(sessionId);
		const key = `${sessionId}:${turn}`;
		const entry = turns.get(key);
		turns.delete(key);
		if (alreadyEnded) return null;
		if (data.reason?.kind !== 'completed') return null;
		if (!entry) return null;
		const lastAssistant = entry.lastAssistantMessage;
		const finalAssistantIsText = lastAssistant?.hasText === true && lastAssistant?.hasToolCall !== true;
		const noToolCallAfterFinalAssistant = lastAssistant !== null &&
			(entry.lastToolCall === null || isAfter(lastAssistant, entry.lastToolCall));
		if (!finalAssistantIsText || !noToolCallAfterFinalAssistant) return null;
		const durationMs = entry.startTime !== null && typeof event.time === 'number' && Number.isFinite(event.time)
			? Math.max(0, event.time - entry.startTime)
			: null;
		entry.notified = true;
		return {
			kind: 'complete',
			sound: 'done',
			sessionId,
			turn,
			/** ms；null = 未知（不播放）。 */
			durationMs,
			/** 首条真实用户消息摘要；null → 日志 fallback "turn #N"。 */
			summary: entry.firstUserMessage ?? null,
			// 防重复：同一 (session, turn) 只通知一次（compaction 不重置 turn 号）。
			dedupeKey: `complete:${sessionId}:${turn}`
		};
	};

	return { onTurnStart, onUserMessage, onAssistantMessage, onToolCall, onTurnEnd };
}
