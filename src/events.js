/**
 * dsh-notify-bell — 事件分类模块（v0.11：final-answer completion）。
 *
 * 把原始 Cordis/DSH 事件载荷归一化为「通知语义」，不在这里做任何输出，
 * 也完全不关心 BEL 响几次/什么节奏（那是 bell backend 的内部细节）：
 *   - goal/changed（block）→ 通知事件（block → block sound）；
 *     goal/changed complete 已不产生任何通知（完成语义由 turn/end 承担，
 *     见 turns.js，避免与最终回答完成双响）
 *   - session/event 的 approval/asked → 通知事件（approval → permission）；
 *     approval/decided 不通知
 *   - session/event 的 tool/call + ask_user_question → 提问通知
 *   - agent/error → 通知事件（error → error）
 *   - 其余操作（create/edit/pause/resume/clear 等）→ null（不通知）
 *
 * 配置可能覆盖 sound（见 config.js 的 events.*.sound）；这里的 sound
 * 是事件自身的语义默认值。
 */
export const NOTIFY_OPERATIONS = ['block'];

/** 事件类型 → 默认语义 sound（与 config.js 的 DEFAULT_EVENT_SOUNDS 一致）。 */
export const EVENT_SOUNDS = Object.freeze({
	complete: 'done',
	block: 'block',
	approval: 'permission',
	question: 'question',
	error: 'error'
});

/**
 * 分类 goal/changed 载荷。
 * @param change - goal/changed 事件的 change 字段。
 * @returns 通知事件或 null（非通知操作 / 载荷缺失）。
 */
export function classifyGoalChange(change) {
	if (!change || !NOTIFY_OPERATIONS.includes(change.operation)) return null;
	const goal = change.goal ?? null;
	const ref = change.ref ?? null;
	return {
		kind: change.operation,
		sound: EVENT_SOUNDS[change.operation],
		ref,
		goal,
		objective: goal?.objective ?? null,
		createdAt: typeof goal?.createdAt === 'number' ? goal.createdAt : null,
		// 防重复：同一 (goal id, revision) 只通知一次。
		dedupeKey: ref ? `${ref.id}@${ref.revision}` : `goal:${change.operation}:${goal?.id ?? 'unknown'}`
	};
}

/**
 * 分类 session/event 载荷中的 approval/asked（权限问题被提出）。
 * approval/decided 不返回通知（不触发通知）。
 * @param session - 拥有该事件的 session（提供 sessionId 用于去重）。
 * @param event - session 事件（type === 'approval/asked' 才分类）。
 * @returns 通知事件或 null（非 approval/asked / 载荷缺失）。
 */
export function classifyApproval(session, event) {
	if (!event || event.type !== 'approval/asked') return null;
	const data = event.data ?? {};
	const id = typeof data.id === 'string' && data.id.length > 0 ? data.id : 'unknown';
	const sessionId = session?.id ?? 'unknown';
	return {
		kind: 'approval',
		sound: EVENT_SOUNDS.approval,
		sessionId,
		approvalId: id,
		toolName: typeof data.toolName === 'string' && data.toolName.length > 0 ? data.toolName : '(unknown tool)',
		// reason 缺失时为 null，日志层不输出 undefined/null。
		reason: typeof data.reason === 'string' && data.reason.length > 0 ? data.reason : null,
		// 防重复：同一 (session, approval id) 只通知一次。
		dedupeKey: `approval:${sessionId}:${id}`
	};
}

/**
 * 分类 session/event 载荷中的 Agent 提问（tool/call + ask_user_question）。
 *
 * Agent 主动提问的真实事件链（已从 DSH 源码确认）：
 *   dsh-tool-ask-user 工具 → ctx.userQuestions.ask() → dsh-host-apiproxy 的
 *   UI Provider 发出 question/requested 下行帧（Web 显示问题卡片）。
 *   Host 侧可靠监听点是 session 的 durable tool/call 事件：
 *     event.type === 'tool/call' && event.data.name === 'ask_user_question'。
 *   tool/result（回答后）与 question/resolved 下行帧都不匹配本分类 → 不通知。
 *
 * 与 approval 完全独立：approval = 等待批准工具操作（approval/asked）；
 * question = Agent 主动提问（tool/call + ask_user_question）。
 *
 * @param session - 拥有该事件的 session（提供 sessionId 用于去重）。
 * @param event - session 事件。
 * @returns 通知事件或 null（非提问 / 载荷缺失）。
 */
export function classifyQuestion(session, event) {
	if (!event || event.type !== 'tool/call') return null;
	const data = event.data ?? {};
	if (data.name !== 'ask_user_question') return null;
	let args = {};
	try {
		args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : {};
	} catch {
		// 参数解析失败 → 仍通知（问题文本缺失由日志层兜底）
	}
	const questions = Array.isArray(args.questions) ? args.questions : [];
	const first = questions[0] ?? {};
	return {
		kind: 'question',
		sound: EVENT_SOUNDS.question,
		sessionId: session?.id ?? 'unknown',
		callId: typeof data.callId === 'string' && data.callId.length > 0 ? data.callId : 'unknown',
		questionText: typeof first.question === 'string' && first.question.length > 0 ? first.question : null,
		optionsCount: Array.isArray(first.options) ? first.options.length : 0,
		questionCount: questions.length,
		// 防重复：同一 (session, tool callId) 只通知一次（callId durable 且全局唯一）。
		dedupeKey: `question:${session?.id ?? 'unknown'}:${data.callId ?? 'unknown'}`
	};
}

/**
 * 分类 agent/error 载荷（step/turn 出错时的可靠通知事件，见
 * @deepseek-ai/dsh-agent 的 agent/error emit 事件）。
 * @param payload - agent/error 事件的完整载荷 { agent, turn, step, error }。
 * @returns 通知事件或 null（载荷缺失）。
 */
export function classifyAgentError(payload) {
	if (!payload) return null;
	const { agent, turn, step, error } = payload;
	const message = error instanceof Error
		? error.message
		: typeof error === 'string' ? error : String(error);
	return {
		kind: 'error',
		sound: EVENT_SOUNDS.error,
		agentId: agent?.id ?? 'unknown',
		turn: typeof turn === 'number' ? turn : null,
		step: typeof step === 'number' ? step : null,
		message,
		dedupeKey: `error:${agent?.id ?? 'unknown'}@${turn ?? '-'}@${step ?? '-'}`
	};
}
