/**
 * dsh-notify-bell — turn 跟踪模块（v0.11：final-answer completion）。
 *
 * 职责单一：维护主会话每个 turn 的状态 —— turn/start 起始时间与首条
 * 真实用户消息 —— 并在 turn/end(reason.completed) 时产出 complete
 * 语义事件。不负责输出/播放/去重（那是 index.js 的职责）。
 *
 * 事件链（已从 DSH 源码确认，dsh-agent-loop/lib/index.js）：
 *   turn/start → [step 循环: assistant/chunk → assistant/message →
 *   tool/call → approval/asked …] → turn/end
 *   - turn/end 的 data.reason.kind === "completed" 表示正常回答完成
 *     （Web UI 也用 turn/end 把 turn 标记为 closed）。
 *   - 子代理也产生 turn/end，但它们的 session header 的
 *     delegationDepth > 0 —— 只有 === 0 的主会话才通知。
 *
 * 时间轴以事件自身 event.time 为准（replay / 重放安全），不用 Date.now()。
 */
export function createTurnTracker(options = {}) {
	/** 是否主会话（delegationDepth === 0 才算；无法确定时保守拒绝）。 */
	const isMainSession = options.isMainSession ??
		((session) => session?.header?.delegationDepth === 0);

	/** `${sessionId}:${turn}` → { startTime, firstUserMessage }。 */
	const turns = new Map();

	/**
	 * 当前打开的 turn（sessionId → turn）。user/message 事件本身不带
	 * turn 字段（append 的就是 message 本体，见 dsh-agent-loop
	 * session.append("user/message", message)），只能按"最近一次
	 * turn/start"归属。
	 */
	const currentTurns = new Map();

	/** 提取真实用户输入文本（只认 source.kind === 'user'，排除系统注入）。 */
	const extractUserText = (event) => {
		const data = event?.data ?? {};
		if (data.source?.kind !== 'user') return null;
		const text = (Array.isArray(data.content) ? data.content : [])
			.filter((block) => block?.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('')
			.replace(/\s+/g, ' ') // 多行/空白 → 单行空格
			.trim();
		return text.length > 0 ? text : null;
	};

	/**
	 * turn/start：记录起始时间（event.time）并置为当前 turn。
	 * 非主会话不跟踪（不占内存）。
	 */
	const onTurnStart = (session, event) => {
		if (!isMainSession(session)) return;
		const turn = event?.data?.turn;
		if (typeof turn !== 'number') return;
		const sessionId = session?.id ?? 'unknown';
		currentTurns.set(sessionId, turn);
		turns.set(`${sessionId}:${turn}`, {
			startTime: typeof event.time === 'number' ? event.time : null,
			firstUserMessage: null
		});
	};

	/**
	 * user/message：记录当前 turn 的首条真实用户输入
	 * （source.kind === 'user'，排除系统注入快照）。
	 * 之后的 user/message 不覆盖首条。
	 */
	const onUserMessage = (session, event) => {
		if (!isMainSession(session)) return;
		const sessionId = session?.id ?? 'unknown';
		const turn = currentTurns.get(sessionId);
		if (typeof turn !== 'number') return;
		const entry = turns.get(`${sessionId}:${turn}`);
		if (!entry || entry.firstUserMessage !== null) return;
		const text = extractUserText(event);
		if (text !== null) entry.firstUserMessage = text;
	};

	/**
	 * turn/end：主会话 + reason.kind === 'completed' 才产出 complete。
	 * - 缺少对应 turn/start（插件中途启动/热加载）→ durationMs = null
	 *   （未知时长，调用方只日志不播放）。
	 * - 一次性消费：状态读取后即删除（配合 index.js 的去重 Set 双保险）。
	 * @returns 通知事件或 null（非主会话 / 非 completed / 载荷缺失）。
	 */
	const onTurnEnd = (session, event) => {
		if (!event || event.type !== 'turn/end') return null;
		if (!isMainSession(session)) return null;
		const data = event?.data ?? {};
		if (data.reason?.kind !== 'completed') return null;
		const turn = data.turn;
		if (typeof turn !== 'number') return null;
		const sessionId = session?.id ?? 'unknown';
		currentTurns.delete(sessionId);
		const key = `${sessionId}:${turn}`;
		const entry = turns.get(key);
		turns.delete(key);
		const durationMs = entry !== undefined && typeof entry.startTime === 'number' && typeof event.time === 'number'
			? Math.max(0, event.time - entry.startTime)
			: null;
		return {
			kind: 'complete',
			sound: 'done',
			sessionId,
			turn,
			/** ms；null = 未知（不播放）。 */
			durationMs,
			/** 首条真实用户消息摘要；null → 日志 fallback "turn #N"。 */
			summary: entry?.firstUserMessage ?? null,
			// 防重复：同一 (session, turn) 只通知一次（compaction 不重置 turn 号）。
			dedupeKey: `complete:${sessionId}:${turn}`
		};
	};

	return { onTurnStart, onUserMessage, onTurnEnd };
}
