/**
 * dsh-notify-bell v0.11.1 — 全量测试（strict final-assistant-text completion + approval/question + Config schema）。
 *
 * 配置测试（loadConfig / sanitizeConfig / defaultConfigPath）：
 *   C1 默认配置深比较（含 approval、permissionGapMs）
 *   C2 无配置文件（ENOENT）回退默认
 *   C3 非法 JSON 回退默认 + warning
 *   C4 字段级类型校验（非法回退、合法保留）
 *   C5 环境变量覆盖配置路径
 *   C6 合法完整配置被采用
 *
 * 行为测试（apply + mock ctx + 注入 write/isTTY/configPath）：
 *   B1 create 不响
 *   B2 complete > minDuration：done + ✓ completed (Ns)
 *   B3 complete < minDuration：不响只日志
 *   B4 block：block sound（2 声）+ ⚠ blocked (Ns)
 *   B5 duplicate complete：只 1 声
 *   B6 objective 截断 120+…
 *   B7 非 TTY：不响但保留日志
 *   B8 自定义 minDuration
 *   B9 自定义 sound：complete.sound=permission → 2 声
 *   B10 自定义 sound：block.sound=error → 3 声
 *   B11 error 事件：默认 error（3 声）+ 自定义 sound + 去重
 *   B12 enabled=false：全事件无输出
 *   B13 bellGapMs：多声间隔受控
 *   B14 objective.maxLength 自定义截断
 *   B15 error 日志格式（turn/step）
 *
 * v4 新增（保留）：
 *   N1 默认配置 sound / N2 自定义 sound / N3 未知 sound 回退
 *   N4 旧 bellCount 兼容 / N4b 旧 bellCount 行为 / N5 soundPack
 *   N6 BEL backend 映射 / N7 events.js 无 bellCount / N8 配置层无 bellCount
 *
 * v0.11 新增：
 *   T1-T24 turn/end(completed) 完成语义（时长/去重/子代理过滤/摘要/
 *   goal complete 静音/联动/backend）
 *
 * v0.11.1 C1 严格化：
 *   T18a/T18b 拆分空 no-op 与有最终 assistant text 的无 user 轮次；
 *   C1-1..C1-15 覆盖 no-op / 正常 / goal round / tool-call-only /
 *   文本后 tool/call / 多 assistant / 重复 end / 非 completed /
 *   子 agent / 长短 duration / 缺 turn/start / 混合 text+tool-call /
 *   非 completed 后完整重放。
 *
 * v0.10 新增：
 *   S1-S6 官方 Config schema（默认值/校验 fail loudly）+ mergeConfig 优先级
 *
 * v5 新增：
 *   A1 approval/asked → 🔐 日志 + permission（2 声）
 *   A2 approval/decided → 不通知
 *   A3 duplicate approval/asked → 只通知一次
 *   A4 approval toolName/reason 日志格式
 *   A5 reason 缺失（不输出 undefined/null）
 *   A6 approval 非 TTY：不响但保留日志
 *   A7 events.approval.enabled=false → 不通知
 *   A8 自定义 approval sound（=error → 3 声）
 *   A9 permission 300ms 节奏 + 与 block（gapMs）节奏不同
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, sanitizeConfig, defaultConfigPath, DEFAULT_CONFIG, cloneDefaults, SEMANTIC_SOUNDS, Config, mergeConfig, explicitFields } from './config.js';
import { createBellBackend } from './bell.js';
import { createWavBackend, detectPlatform, detectWindowsPlayer, detectLinuxPlayer, detectPlayerFor } from './wav.js';
import { writeEnabled } from './config.js';
import { classifyGoalChange, classifyApproval, classifyQuestion, classifyAgentError } from './events.js';
import { apply } from './index.js';

const report = (line) => process.stdout.write(line + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;
const check = (cond, label, actual) => {
	if (!cond) { failed = true; report(`FAIL: ${label} (actual: ${JSON.stringify(actual)})`); }
};

// ---------- 基础设施 ----------
const GAP = 20; // 行为测试统一用 20ms 加速（permissionGapMs 也用小值加速）
let tty = true;
/** 创建一次性临时配置 + mock ctx + 捕获器。configObj 为 null 时不写文件。 */
function setup(configObj) {
	const dir = mkdtempSync(join(tmpdir(), 'notify-bell-'));
	const file = join(dir, 'config.json');
	if (configObj !== null) writeFileSync(file, typeof configObj === 'string' ? configObj : JSON.stringify(configObj));
	const writes = []; // { t, c }
	const warns = [];
	const listeners = new Map();
	const ctx = { on: (event, handler) => listeners.set(event, handler), inject: () => {} };
	const emit = (event, ...args) => listeners.get(event)(...args);
	const applyPlugin = (extra = {}) => apply(ctx, {}, {
		configPath: file,
		write: (chunk) => writes.push({ t: Date.now(), c: String(chunk) }),
		isTTY: () => tty,
		warn: (message) => warns.push(message),
		...extra
	});
	const bells = () => writes.filter((w) => w.c === '\x07').map((w) => w.t);
	const logLines = () => writes.filter((w) => w.c.startsWith('[notify-bell]')).map((w) => w.c.trimEnd());
	return { dir, file, writes, warns, ctx, emit, applyPlugin, bells, logLines };
}

const GOAL_ID = 'goal-test-1';
const goalView = (phase, { createdAtMs = Date.now() - 30_000, objective = '为 deepseek harness 制作通知插件', revision = 3 } = {}) => ({
	id: GOAL_ID,
	revision,
	objective,
	phase,
	maxGoalRounds: 10,
	roundsStarted: 2,
	createdAt: createdAtMs,
	updatedAt: Date.now(),
	activation: 'disarmed'
});
const goalChange = (operation, goal, revision = 3) => ({ operation, ref: { id: GOAL_ID, revision }, ...(goal ? { goal } : {}) });
const MOCK_SESSION = { id: 'session-1' };

// ---------- v0.11 turn 基建（final-answer completion） ----------
const MAIN_SESSION = { id: 'session-main', header: { id: 'session-main', delegationDepth: 0 } };
const SUB_SESSION = { id: 'session-sub', header: { id: 'session-sub', delegationDepth: 1 } };
let messageSeq = 0;
const nextId = (prefix) => `${prefix}-${++messageSeq}`;
const withSeq = (event, seq) => Number.isInteger(seq) ? { ...event, seq } : event;
const turnStart = (turn, time, seq) => withSeq({ type: 'turn/start', time, data: { turn } }, seq);
const turnUserMsg = (turn, text, time) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: 'm-' + turn } });
const goalUserMsg = (turn, text, time) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }], source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 }, role: 'user', id: nextId('goal-msg') } });
const turnEnd = (turn, reason, time, seq) => withSeq({ type: 'turn/end', time, data: { turn, reason: { kind: reason } } }, seq);
const textBlock = (text) => ({ type: 'text', text });
const toolCallBlock = (id, name, args = '{}') => ({ type: 'tool-call', id, name, arguments: args });
/** DSH assistant/message 真实载荷：data.message.content 为 block 数组。 */
const assistantMessage = (turn, content, time, opts = {}) => withSeq({
	type: 'assistant/message',
	time,
	data: {
		turn,
		step: opts.step ?? 1,
		message: {
			id: opts.id ?? nextId('assistant'),
			role: 'assistant',
			source: { kind: 'model', provider: 'mock', model: 'mock' },
			content: Array.isArray(content) ? content : [content]
		},
		...(opts.usage === undefined ? {} : { usage: opts.usage })
	}
}, opts.seq);
const assistantText = (turn, text, time, opts = {}) => assistantMessage(turn, textBlock(text), time, opts);
/** DSH tool/call 真实载荷：turn/step/callId/name/arguments。 */
const toolCall = (turn, callId, name, time, opts = {}) => withSeq({
	type: 'tool/call',
	time,
	data: {
		turn,
		step: opts.step ?? 1,
		callId,
		name,
		arguments: opts.arguments ?? '{}'
	}
}, opts.seq);
const toolResult = (turn, callId, time, opts = {}) => ({
	type: 'tool/result',
	time,
	data: {
		turn,
		step: opts.step ?? 1,
		message: {
			id: opts.id ?? nextId('tool-result'),
			role: 'user',
			source: { kind: 'tool', callId },
			content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: opts.text ?? 'ok' }] }]
		}
	}
});
/** 正常完成一轮：turn/start → user/message → assistant/message(final text) → turn/end(completed)。默认 30s 时长。 */
const completeTurn = (s, turn, opts = {}) => {
	const now = opts.endTime ?? Date.now();
	const start = now - (opts.startAgoMs ?? 30_000);
	s.emit('session/event', MAIN_SESSION, turnStart(turn, start, opts.startSeq));
	if (opts.userMessage !== false) s.emit('session/event', MAIN_SESSION, turnUserMsg(turn, opts.text ?? '为 deepseek harness 制作通知插件', start + 5));
	if (opts.assistant !== false) s.emit('session/event', MAIN_SESSION, assistantText(turn, opts.finalText ?? '最终回答', now - (opts.finalTextAgoMs ?? 1_000), { step: opts.step ?? 1, seq: opts.assistantSeq }));
	s.emit('session/event', MAIN_SESSION, turnEnd(turn, 'completed', now, opts.endSeq));
};
/** goal 自动续跑轮次：无 human user/message，但有最终 assistant text。 */
const completeGoalRound = (s, turn, opts = {}) => {
	const now = opts.endTime ?? Date.now();
	const start = now - (opts.startAgoMs ?? 30_000);
	s.emit('session/event', MAIN_SESSION, turnStart(turn, start));
	s.emit('session/event', MAIN_SESSION, goalUserMsg(turn, opts.text ?? '继续完成目标', start + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(turn, opts.finalText ?? '目标已完成', now - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(turn, 'completed', now));
};
/** no-op 空 claim：turn/start → turn/end(completed)，中间无任何消息。 */
const completeNoOpTurn = (s, turn, opts = {}) => {
	const now = opts.endTime ?? Date.now();
	const start = now - (opts.startAgoMs ?? 30_000);
	s.emit('session/event', MAIN_SESSION, turnStart(turn, start));
	s.emit('session/event', MAIN_SESSION, turnEnd(turn, 'completed', now));
};
const approvalEvent = (overrides = {}) => ({
	type: 'approval/asked',
	data: { id: 'req-1', toolName: 'bash', reason: '需要提升权限', ...overrides }
});

// ---------- C: 配置 ----------
{
	const { config, source } = loadConfig({ configPath: join(tmpdir(), 'definitely-missing-xyz.json') });
	check(source === 'default', 'C1 source default', source);
	const expected = cloneDefaults();
	check(config.enabled === expected.enabled && config.minDuration === expected.minDuration, 'C1 defaults core values', config);
	check(config.wav.fallback === 'bell', 'C1 wav fallback default', config.wav.fallback);
	check(config.wav.directory === join(homedir(), '.config', 'dsh', 'notify-bell', 'sounds'), 'C1 wav directory expanded', config.wav.directory);
	check(config.enabled === true && config.minDuration === 10 && config.objective.maxLength === 120, 'C1 defaults core', config);
	check(config.events.complete.sound === 'done' && config.events.block.sound === 'block', 'C1 complete/block sounds', config.events);
	check(config.events.approval.sound === 'permission' && config.events.question.sound === 'question' && config.events.error.sound === 'error', 'C1 approval/question/error sounds', config.events);
	check('bellCount' in config.events.complete === false, 'C1 no bellCount in defaults', config.events.complete);
	check(config.soundPack === 'default', 'C1 soundPack', config.soundPack);
	check(config.bell.gapMs === 150 && config.bell.permissionGapMs === 300, 'C1 bell gaps', config.bell);
	report('C1: 默认配置（含 approval/permissionGapMs）✓');
}
{
	const { config, source } = loadConfig({ configPath: '/nonexistent/also-missing.json' });
	check(source === 'default' && config.enabled === true, 'C2 fallback on ENOENT', { source, config });
	report('C2: 无配置文件回退默认 ✓');
}
{
	const s = setup('{{{ not json');
	const { config, source } = loadConfig({ configPath: s.file, warn: (m) => s.warns.push(m) });
	check(source === 'default', 'C3 source default', source);
	check(s.warns.length === 1 && s.warns[0].includes('not valid JSON'), 'C3 warning emitted', s.warns);
	check(config.soundPack === 'default' && config.wav.fallback === 'bell', 'C3 defaults on invalid JSON', config);
	check(config.wav.directory === join(homedir(), '.config', 'dsh', 'notify-bell', 'sounds'), 'C3 wav directory expanded', config.wav.directory);
	rmSync(s.dir, { recursive: true, force: true });
	report('C3: 非法 JSON 回退默认 + warning ✓');
}
{
	const raw = {
		enabled: 'yes',
		minDuration: -5,
		objective: { maxLength: 0 },
		events: {
			complete: { sound: 123, enabled: false },
			block: { bellCount: 5 },
			approval: { sound: 'bogus-sound' },
			error: { sound: '' }
		},
		soundPack: 'webhook',
		bell: { gapMs: 'fast', permissionGapMs: -1 }
	};
	const cfg = sanitizeConfig(raw);
	check(cfg.enabled === true, 'C4 enabled fallback', cfg.enabled);
	check(cfg.minDuration === 10, 'C4 minDuration fallback', cfg.minDuration);
	check(cfg.objective.maxLength === 120, 'C4 maxLength fallback', cfg.objective.maxLength);
	check(cfg.events.complete.enabled === false && cfg.events.complete.sound === 'done', 'C4 complete mixed', cfg.events.complete);
	check(cfg.events.block.sound === 'block', 'C4 block bellCount(5) falls back to block', cfg.events.block.sound);
	check(cfg.events.approval.sound === 'permission', 'C4 approval unknown sound falls back', cfg.events.approval.sound);
	check(cfg.events.error.sound === 'error', 'C4 error unknown sound falls back', cfg.events.error.sound);
	check(cfg.soundPack === 'default', 'C4 soundPack fallback', cfg.soundPack);
	check(cfg.bell.gapMs === 150 && cfg.bell.permissionGapMs === 300, 'C4 bell gaps fallback', cfg.bell);
	report('C4: 类型校验（非法回退/合法保留）✓');
}
{
	const dir = mkdtempSync(join(tmpdir(), 'notify-bell-env-'));
	const file = join(dir, 'custom.json');
	writeFileSync(file, JSON.stringify({ minDuration: 42 }));
	const { config, source } = loadConfig({ env: { DSH_NOTIFY_BELL_CONFIG: file } });
	check(source === 'file' && config.minDuration === 42, 'C5 env path honored', { source, minDuration: config.minDuration });
	check(defaultConfigPath({}, '/home/x') === '/home/x/.config/dsh/notify-bell.json', 'C5 default path shape', defaultConfigPath({}, '/home/x'));
	check(defaultConfigPath({ DSH_NOTIFY_BELL_CONFIG: '/a/b.json' }) === '/a/b.json', 'C5 override path', defaultConfigPath({ DSH_NOTIFY_BELL_CONFIG: '/a/b.json' }));
	rmSync(dir, { recursive: true, force: true });
	report('C5: 环境变量覆盖配置路径 ✓');
}
{
	const s = setup({
		enabled: false, minDuration: 30, objective: { maxLength: 50 },
		events: { complete: { sound: 'permission' }, block: { sound: 'done' }, approval: { sound: 'error' }, error: { sound: 'default' } },
		soundPack: 'default', bell: { gapMs: 200, permissionGapMs: 500 }
	});
	const { config, source } = loadConfig({ configPath: s.file });
	check(source === 'file', 'C6 source file', source);
	check(config.enabled === false && config.minDuration === 30 && config.objective.maxLength === 50, 'C6 adopted values', config);
	check(config.events.complete.sound === 'permission' && config.events.block.sound === 'done', 'C6 complete/block sounds', config.events);
	check(config.events.approval.sound === 'error' && config.events.error.sound === 'default', 'C6 approval/error sounds', config.events);
	check(config.soundPack === 'default' && config.bell.gapMs === 200 && config.bell.permissionGapMs === 500, 'C6 adopted soundPack/gaps', config);
	rmSync(s.dir, { recursive: true, force: true });
	report('C6: 合法完整配置被采用 ✓');
}

// ---------- B: 行为 ----------
// B1: create 不响（默认配置 + 加速 gapMs）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('create', goalView('active')) });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'B1 create silent', s.writes);
	check(s.logLines().length === 0, 'B1 create no log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('B1: create 不响 ✓');
}

// B2: complete 30s >= 10s → done（1 声）+ 日志格式
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 30_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'B2 one BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (30s): 为 deepseek harness 制作通知插件 (turn #1)', 'B2 log format', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B2: complete>minDuration 响 1 声（done）✓');
}

// B3: complete 2s < 10s → 不响，只日志
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 2_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'B3 no BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (2s): 为 deepseek harness 制作通知插件 (turn #1)', 'B3 short log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B3: complete<minDuration 不响 ✓');
}

// B4: block → block sound（2 声）+ 日志（不受 minDuration 限制：2s）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked', { createdAtMs: Date.now() - 2_000 })) });
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'B4 two BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ⚠ blocked (2s): 为 deepseek harness 制作通知插件', 'B4 block log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B4: block 响 2 声（block sound）✓');
}

// B5: duplicate complete（同 ref）→ 只 1 声 1 日志
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now() + 100));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'B5 one BEL', s.bells());
	check(s.logLines().length === 1, 'B5 one log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('B5: 重复 complete 只响 1 声 ✓');
}

// B6: objective 截断 120 + …
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '字'.repeat(150) });
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	const summary = l[0]?.split(': ')[1]?.split(' (turn #')[0];
	check(summary?.length === 121 && summary.endsWith('…') && summary.slice(0, 120) === '字'.repeat(120), 'B6 truncated 120+…', summary?.length);
	rmSync(s.dir, { recursive: true, force: true });
	report('B6: objective 截断 ✓');
}

// B7: 非 TTY 不响但保留日志
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	tty = false;
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	tty = true;
	check(s.bells().length === 0, 'B7 no BEL non-TTY', s.bells());
	check(s.logLines().length === 1, 'B7 log kept', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('B7: 非 TTY 不响但保留日志 ✓');
}

// B8: 自定义 minDuration（20s；complete 15s → 不响）
{
	const s = setup({ minDuration: 20, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 15_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'B8 no BEL under custom minDuration', s.bells());
	check(s.logLines().length === 1 && s.logLines()[0].includes('✓ completed (15s)'), 'B8 log kept', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('B8: 自定义 minDuration ✓');
}

// B9: 自定义 sound：complete.sound=permission → 2 声
{
	const s = setup({ events: { complete: { sound: 'permission' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'B9 two BEL (permission)', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('B9: 自定义 sound（complete=permission → 2 声）✓');
}

// B10: 自定义 sound：block.sound=error → 3 声
{
	const s = setup({ events: { block: { sound: 'error' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked')) });
	await sleep(GAP * 4 + 30);
	check(s.bells().length === 3, 'B10 three BEL (error)', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('B10: 自定义 sound（block=error → 3 声）✓');
}

// B11: error 事件 → 默认 error（3 声）+ 日志；自定义 sound；去重
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const payload = { agent: { id: 'agent-1' }, turn: 3, step: 1, error: new Error('boom') };
	s.emit('agent/error', payload);
	s.emit('agent/error', payload); // 重复同 (agent, turn, step)
	await sleep(GAP * 4 + 30);
	check(s.bells().length === 3, 'B11 error 3 BEL default', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✗ error (turn 3 step 1): boom', 'B11 error log format', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B11a: error 默认 3 声 + 去重 ✓');
}
{
	const s = setup({ events: { error: { sound: 'permission' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('agent/error', { agent: { id: 'agent-1' }, turn: 1, step: 0, error: 'plain string error' });
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'B11b error custom 2 BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✗ error (turn 1 step 0): plain string error', 'B11b string error log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B11b: 自定义 error sound ✓');
}

// B12: enabled=false → 全事件无输出
{
	const s = setup({ enabled: false, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked')) });
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	s.emit('agent/error', { agent: { id: 'agent-1' }, turn: 1, step: 1, error: new Error('x') });
	await sleep(GAP * 3 + 30);
	check(s.writes.length === 0, 'B12 no output when disabled', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('B12: enabled=false 全关 ✓');
}

// B13: bellGapMs 控制间隔（gapMs=40，block 两声间隔 >= 30ms）
{
	const s = setup({ bell: { gapMs: 40, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked')) });
	await sleep(150);
	const t = s.bells();
	check(t.length === 2 && t[1] - t[0] >= 30, 'B13 gap honored', t);
	rmSync(s.dir, { recursive: true, force: true });
	report('B13: bellGapMs 间隔受控 ✓');
}

// B14: objective.maxLength=5 → 截断 5+…
{
	const s = setup({ objective: { maxLength: 5 }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '一个非常长的目标描述' });
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	const summary = l[0]?.split(': ')[1]?.split(' (turn #')[0];
	check(summary === '一个非常长…', 'B14 custom maxLength', summary);
	rmSync(s.dir, { recursive: true, force: true });
	report('B14: objective.maxLength 自定义 ✓');
}

// B15: error 无 turn 时日志格式
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('agent/error', { agent: { id: 'agent-1' }, turn: undefined, step: undefined, error: new Error('no position') });
	await sleep(GAP * 4 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✗ error: no position', 'B15 error no-position log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('B15: error 无 turn/step 日志格式 ✓');
}

// ---------- N: v4 保留 ----------
// N1: 默认配置 sound 值
{
	check(DEFAULT_CONFIG.events.complete.sound === 'done', 'N1 complete sound', DEFAULT_CONFIG.events.complete.sound);
	check(DEFAULT_CONFIG.events.block.sound === 'block', 'N1 block sound', DEFAULT_CONFIG.events.block.sound);
	check(DEFAULT_CONFIG.events.approval.sound === 'permission', 'N1 approval sound', DEFAULT_CONFIG.events.approval.sound);
	check(DEFAULT_CONFIG.events.error.sound === 'error', 'N1 error sound', DEFAULT_CONFIG.events.error.sound);
	check(JSON.stringify(SEMANTIC_SOUNDS) === JSON.stringify(['done', 'block', 'permission', 'question', 'error', 'default']), 'N1 sound vocabulary', SEMANTIC_SOUNDS);
	report('N1: 默认配置 sound ✓');
}

// N2: 自定义 sound 生效（complete.sound=permission → 2 声）
{
	const s = setup({ events: { complete: { sound: 'permission' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const { config } = loadConfig({ configPath: s.file });
	check(config.events.complete.sound === 'permission', 'N2 config sound', config.events.complete.sound);
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'N2 custom sound -> 2 BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('N2: 自定义 sound（complete=permission → 2 声）✓');
}

// N3: 未知 sound 安全回退到事件默认
{
	const s = setup({ events: { complete: { sound: 'bogus' }, block: { sound: 'weird' }, approval: { sound: 42 }, error: { sound: '' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const { config } = loadConfig({ configPath: s.file });
	check(config.events.complete.sound === 'done', 'N3 complete fallback', config.events.complete.sound);
	check(config.events.block.sound === 'block', 'N3 block fallback', config.events.block.sound);
	check(config.events.approval.sound === 'permission', 'N3 approval fallback', config.events.approval.sound);
	check(config.events.error.sound === 'error', 'N3 error fallback', config.events.error.sound);
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'N3 fallback -> 1 BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('N3: 未知 sound 安全回退 ✓');
}

// N4: 旧 bellCount 兼容：1→done 2→permission 3→error；sound 优先
{
	const cfg = sanitizeConfig({ events: { complete: { bellCount: 1 }, block: { bellCount: 2 }, error: { bellCount: 3 } } });
	check(cfg.events.complete.sound === 'done', 'N4 bellCount 1 -> done', cfg.events.complete.sound);
	check(cfg.events.block.sound === 'permission', 'N4 bellCount 2 -> permission', cfg.events.block.sound);
	check(cfg.events.error.sound === 'error', 'N4 bellCount 3 -> error', cfg.events.error.sound);
	const priority = sanitizeConfig({ events: { complete: { sound: 'error', bellCount: 1 } } });
	check(priority.events.complete.sound === 'error', 'N4 sound wins over bellCount', priority.events.complete.sound);
	const other = sanitizeConfig({ events: { complete: { bellCount: 7 } } });
	check(other.events.complete.sound === 'done', 'N4 bellCount 7 falls back', other.events.complete.sound);
	report('N4: 旧 bellCount 兼容映射 ✓');
}

// N4b: 旧 bellCount 配置的行为验证（block bellCount=2 → permission → 2 声）
{
	const s = setup({ events: { block: { bellCount: 2 } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked')) });
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'N4b legacy bellCount behavior', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('N4b: 旧 bellCount 配置行为兼容 ✓');
}

// N5: soundPack 默认 default；未知 soundPack 回退 default
{
	check(DEFAULT_CONFIG.soundPack === 'default', 'N5 default soundPack', DEFAULT_CONFIG.soundPack);
	const cfg = sanitizeConfig({ soundPack: 'webhook' });
	check(cfg.soundPack === 'default', 'N5 unknown soundPack fallback', cfg.soundPack);
	const ok = sanitizeConfig({ soundPack: 'default' });
	check(ok.soundPack === 'default', 'N5 explicit default kept', ok.soundPack);
	report('N5: soundPack 解析 ✓');
}

// N6: BEL backend 映射（bell.js 是 sound→BEL 次数唯一权威）
{
	const timestamps = [];
	const bell = createBellBackend({
		gapMs: 10,
		permissionGapMs: 10,
		isTTY: () => true,
		write: (c) => timestamps.push({ t: Date.now(), c: String(c) })
	});
	const playAndCount = async (sound, expected) => {
		timestamps.length = 0;
		bell.play(sound);
		await sleep(60);
		return timestamps.filter((w) => w.c === '\x07').length === expected;
	};
	check(await playAndCount('done', 1), 'N6 done -> 1 BEL', 'done');
	check(await playAndCount('block', 2), 'N6 block -> 2 BEL', 'block');
	check(await playAndCount('permission', 2), 'N6 permission -> 2 BEL', 'permission');
	check(await playAndCount('error', 3), 'N6 error -> 3 BEL', 'error');
	check(await playAndCount('default', 1), 'N6 default -> 1 BEL', 'default');
	check(await playAndCount('unknown-sound', 1), 'N6 unknown -> 1 BEL', 'unknown');
	bell.dispose();
	report('N6: BEL backend sound→次数映射 ✓');
}

// N7: events.js 不依赖 bellCount（分类输出只有 sound）
{
	const complete = classifyGoalChange(goalChange('complete', goalView('complete')));
	check(complete === null, 'N7 goal complete no longer classifies (turn/end owns completion)', complete);
	const block = classifyGoalChange(goalChange('block', goalView('blocked')));
	check(block?.kind === 'block' && block.sound === 'block', 'N7 classify block sound', block);
	check('bellCount' in block === false, 'N7 no bellCount in classify block', block);
	const err = classifyAgentError({ agent: { id: 'a' }, turn: 1, step: 1, error: new Error('x') });
	check(err?.kind === 'error' && err.sound === 'error', 'N7 classify error sound', err);
	check('bellCount' in err === false, 'N7 no bellCount in classify error', err);
	const none = classifyGoalChange(goalChange('create', goalView('active')));
	check(none === null, 'N7 create -> null', none);
	report('N7: events.js 只输出语义 sound，无 bellCount ✓');
}

// N8: bell.js 才负责 sound→BEL 映射（配置层无 bellCount 输出）
{
	const cfg = sanitizeConfig({ events: { complete: { sound: 'permission' }, block: { bellCount: 2 }, error: { sound: 'default' } } });
	check('bellCount' in cfg.events.complete === false && 'bellCount' in cfg.events.block === false && 'bellCount' in cfg.events.error === false, 'N8 config never emits bellCount', cfg.events);
	check(cfg.events.complete.sound === 'permission' && cfg.events.block.sound === 'permission' && cfg.events.error.sound === 'default', 'N8 config sounds only', cfg.events);
	report('N8: 事件层/配置层无 bellCount，映射只在 bell.js ✓');
}

// ---------- A: v5 approval 新增 ----------
// A1: approval/asked → 🔐 日志 + permission（2 声）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'A1 permission 2 BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] 🔐 approval: bash: 需要提升权限', 'A1 approval log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('A1: approval/asked → 🔐 日志 + permission ✓');
}

// A2: approval/decided → 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, { type: 'approval/decided', data: { id: 'req-1', outcome: 'allowed-once' } });
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'A2 decided silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('A2: approval/decided 不通知 ✓');
}

// A3: duplicate approval/asked（同 session+id）→ 只通知一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'A3 one notification (2 BEL)', s.bells());
	check(s.logLines().length === 1, 'A3 one log', s.logLines());
	// 不同 approval id → 新通知
	s.emit('session/event', MOCK_SESSION, approvalEvent({ id: 'req-2' }));
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 4, 'A3 different id notifies again', s.bells());
	check(s.logLines().length === 2, 'A3 two logs total', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('A3: duplicate approval 只通知一次 ✓');
}

// A4: approval toolName/reason 日志格式（不同 tool/reason）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent({ id: 'req-9', toolName: 'edit', reason: '写入文件' }));
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] 🔐 approval: edit: 写入文件', 'A4 tool/reason log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('A4: approval toolName/reason 日志 ✓');
}

// A5: reason 缺失（不输出 undefined/null）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent({ id: 'req-10', reason: undefined }));
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] 🔐 approval: bash', 'A5 no-reason log', l);
	check(!l[0].includes('undefined') && !l[0].includes('null') && !l[0].endsWith(':'), 'A5 no undefined/null leak', l[0]);
	rmSync(s.dir, { recursive: true, force: true });
	report('A5: reason 缺失不输出 undefined/null ✓');
}

// A6: approval 非 TTY：不响但保留日志
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	tty = false;
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 3 + 30);
	tty = true;
	check(s.bells().length === 0, 'A6 no BEL non-TTY', s.bells());
	check(s.logLines().length === 1, 'A6 log kept', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('A6: approval 非 TTY 不响但保留日志 ✓');
}

// A7: events.approval.enabled=false → 不通知
{
	const s = setup({ events: { approval: { enabled: false } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'A7 approval disabled silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('A7: events.approval.enabled=false ✓');
}

// A8: 自定义 approval sound（=error → 3 声）
{
	const s = setup({ events: { approval: { sound: 'error' } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 4 + 30);
	check(s.bells().length === 3, 'A8 approval error sound 3 BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('A8: 自定义 approval sound ✓');
}

// A9: permission 300ms 节奏 + 与 block（gapMs）节奏不同
{
	const timestamps = [];
	const bell = createBellBackend({
		gapMs: 10,
		permissionGapMs: 300,
		isTTY: () => true,
		write: (c) => timestamps.push({ t: Date.now(), c: String(c) })
	});
	timestamps.length = 0;
	bell.play('permission');
	await sleep(380);
	const p = timestamps.filter((w) => w.c === '\x07').map((w) => w.t);
	check(p.length === 2 && p[1] - p[0] >= 280, 'A9 permission gap >= 280ms', p);

	timestamps.length = 0;
	bell.play('block');
	await sleep(60);
	const b = timestamps.filter((w) => w.c === '\x07').map((w) => w.t);
	check(b.length === 2 && b[1] - b[0] < 60, 'A9 block gap ~10ms', b);
	check(p[1] - p[0] > b[1] - b[0] + 200, 'A9 permission slower than block', { p: p[1] - p[0], b: b[1] - b[0] });
	bell.dispose();
	report('A9: permission 300ms 节奏与 block 不同 ✓');
}

// ---------- W: v6 WAV backend 新增 ----------
// W1: wav 配置解析（soundPack、directory 展开、fallback 校验）
{
	const dir = mkdtempSync(join(tmpdir(), 'nb-wav-'));
	const file = join(dir, 'c.json');
	writeFileSync(file, JSON.stringify({ soundPack: 'wav', wav: { directory: '~/my/sounds', fallback: 'bell' } }));
	const { config } = loadConfig({ configPath: file });
	check(config.soundPack === 'wav', 'W1 soundPack wav', config.soundPack);
	check(config.wav.directory === join(homedir(), 'my', 'sounds'), 'W1 directory expanded', config.wav.directory);
	check(config.wav.fallback === 'bell', 'W1 fallback bell', config.wav.fallback);
	const bad = sanitizeConfig({ soundPack: 'wav', wav: { directory: 42, fallback: 'other' } });
	check(bad.wav.directory === join(homedir(), '.config', 'dsh', 'notify-bell', 'sounds'), 'W1 bad directory fallback', bad.wav.directory);
	check(bad.wav.fallback === 'bell', 'W1 bad fallback', bad.wav.fallback);
	const notWav = sanitizeConfig({ soundPack: 'bogus' });
	check(notWav.soundPack === 'default', 'W1 unknown pack fallback', notWav.soundPack);
	rmSync(dir, { recursive: true, force: true });
	report('W1: wav 配置解析 ✓');
}

// W2: 文件存在 + player 可用 → spawn 播放（不 fallback）
{
	const spawned = [];
	const handlers = {};
	const fakeSpawn = (cmd, args) => {
		const child = { on: (e, h) => { handlers[e] = h; return child; } };
		spawned.push({ cmd, args });
		return child;
	};
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const wav = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\sounds\\done.wav') }),
		existsSync: () => true,
		bell: fakeBell
	});
	wav.play('done');
	check(spawned.length === 1, 'W2 spawn called', spawned.length);
	check((spawned[0]?.args ?? []).join(' ').includes('System.Media.SoundPlayer'), 'W2 soundplayer script', spawned[0]?.args);
	check(fakeBell.playCalls.length === 0, 'W2 no fallback on success', fakeBell.playCalls);
	report('W2: 文件存在 + player 可用 → 播放 ✓');
}

// W3: 文件不存在 → fallback BEL（不 spawn）
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const wav = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => false,
		bell: fakeBell
	});
	wav.play('done');
	check(spawned.length === 0, 'W3 no spawn', spawned.length);
	check(fakeBell.playCalls.length === 1 && fakeBell.playCalls[0] === 'done', 'W3 fallback bell', fakeBell.playCalls);
	report('W3: 文件不存在 → fallback BEL ✓');
}

// W4: 播放器不可用（null）→ fallback BEL
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const wav = createWavBackend({
		directory: '/sounds',
		player: null,
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => true,
		bell: fakeBell
	});
	wav.play('error');
	check(spawned.length === 0, 'W4 no spawn', spawned.length);
	check(fakeBell.playCalls[0] === 'error', 'W4 fallback bell', fakeBell.playCalls);
	report('W4: 播放器不可用 → fallback BEL ✓');
}

// W4b: 播放进程非零退出 → fallback BEL（只一次）
{
	const spawned = [];
	const handlersMap = {};
	const fakeSpawn = (cmd, args) => {
		const child = { on: (e, h) => { handlersMap[e] = h; return child; } };
		spawned.push({ cmd, args });
		return child;
	};
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const wav = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => true,
		bell: fakeBell
	});
	wav.play('done');
	handlersMap.exit?.(1);
	check(fakeBell.playCalls.length === 1, 'W4b exit nonzero fallback', fakeBell.playCalls);
	handlersMap.exit?.(1); // 重复 exit 不应再 fallback
	check(fakeBell.playCalls.length === 1, 'W4b no double fallback', fakeBell.playCalls);
	report('W4b: 非零退出 → fallback（只一次）✓');
}

// W5: 非 TTY + wav：文件存在仍播放；文件缺失时 fallback 的 BEL 不响
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const wavBell = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => true,
		bell: createBellBackend({ gapMs: 10, isTTY: () => false, write: () => {} })
	});
	wavBell.play('done');
	check(spawned.length === 1, 'W5 wav plays regardless of TTY', spawned.length);

	const writes = [];
	const wavBell2 = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => false,
		bell: createBellBackend({ gapMs: 10, isTTY: () => false, write: (c) => writes.push(String(c)) })
	});
	const before = spawned.length;
	wavBell2.play('block');
	await sleep(30);
	check(spawned.length === before, 'W5 no spawn when file missing', spawned.length);
	check(writes.filter((w) => w === '\\x07').length === 0 && writes.filter((w) => w === '\x07').length === 0, 'W5 no BEL non-TTY fallback', writes);
	report('W5: 非 TTY + wav（播放照常 / fallback 不响）✓');
}

// W6: apply 级：enabled=false + wav 配置 → 不播放不输出
{
	const spawned = [];
	const s = setup({ enabled: false, soundPack: 'wav', wav: { directory: '/tmp/x' }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	apply(s.ctx, {}, {
		configPath: s.file,
		write: (c) => s.writes.push({ t: Date.now(), c: String(c) }),
		isTTY: () => tty,
		warn: (m) => s.warns.push(m),
		spawn: (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; },
		existsSync: () => true,
		player: { cmd: 'powershell.exe' }
	});
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'W6 no output', s.writes);
	check(spawned.length === 0, 'W6 no spawn', spawned.length);
	rmSync(s.dir, { recursive: true, force: true });
	report('W6: enabled=false + wav 不播放 ✓');
}

// W7: 四个 sound 映射正确（done/permission/block/error → 对应文件名）
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const wav = createWavBackend({
		directory: '/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: (cmd, args) => {
			const file = args[args.length - 1];
			const base = file.split('/').pop();
			return { status: 0, stdout: Buffer.from('C:\\sounds\\' + base) };
		},
		existsSync: () => true,
		bell: { play: () => {}, dispose: () => {} }
	});
	const expected = { done: 'done.wav', permission: 'permission.wav', block: 'block.wav', error: 'error.wav' };
	for (const sound of ['done', 'permission', 'block', 'error']) {
		wav.play(sound);
		const script = (spawned[spawned.length - 1]?.args ?? []).join(' ');
		check(script.includes(expected[sound]), `W7 ${sound} -> ${expected[sound]}`, script);
	}
	check(spawned.length === 4, 'W7 four plays', spawned.length);
	report('W7: 四个 sound 映射正确 ✓');
}

// W8: WAV backend 不影响事件层（approval 事件照常 → 🔐 日志 + 播 permission.wav）
{
	const spawned = [];
	const s = setup({ soundPack: 'wav', wav: { directory: '/tmp/sounds' }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	apply(s.ctx, {}, {
		configPath: s.file,
		write: (c) => s.writes.push({ t: Date.now(), c: String(c) }),
		isTTY: () => tty,
		warn: (m) => s.warns.push(m),
		spawn: (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; },
		existsSync: () => true,
		player: { cmd: 'powershell.exe' }
	});
	s.emit('session/event', MOCK_SESSION, approvalEvent());
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] 🔐 approval: bash: 需要提升权限', 'W8 approval log unchanged', l);
	check(spawned.length === 1 && spawned[0].args.join(' ').includes('permission.wav'), 'W8 wav played for approval', spawned.map((x) => x.args.join(' ')));
	const c = classifyApproval(MOCK_SESSION, approvalEvent());
	check('directory' in c === false && 'wav' in c === false, 'W8 classify has no wav fields', c);
	rmSync(s.dir, { recursive: true, force: true });
	report('W8: WAV backend 不影响事件层 ✓');
}

// ---------- X: v7 平台 backend 新增 ----------
// X1: 平台检测（win32 / WSL env / /proc/version / 普通 linux / other）
{
	check(detectPlatform({}, 'win32') === 'windows', 'X1 win32', detectPlatform({}, 'win32'));
	check(detectPlatform({ WSL_INTEROP: '/run/WSL/8_interop' }, 'linux') === 'wsl', 'X1 WSL_INTEROP', detectPlatform({ WSL_INTEROP: '/run/WSL/8_interop' }, 'linux'));
	check(detectPlatform({ WSL_DISTRO_NAME: 'Ubuntu-26.04' }, 'linux') === 'wsl', 'X1 WSL_DISTRO_NAME', detectPlatform({ WSL_DISTRO_NAME: 'Ubuntu-26.04' }, 'linux'));
	check(detectPlatform({}, 'linux', () => 'Linux version 5.15.153.1-microsoft-standard-WSL2') === 'wsl', 'X1 /proc/version microsoft', detectPlatform({}, 'linux', () => 'Linux version 5.15.153.1-microsoft-standard-WSL2'));
	check(detectPlatform({}, 'linux', () => 'Linux version 6.8.0-45-generic') === 'linux', 'X1 plain linux', detectPlatform({}, 'linux', () => 'Linux version 6.8.0-45-generic'));
	check(detectPlatform({}, 'darwin') === 'other', 'X1 other', detectPlatform({}, 'darwin'));
	report('X1: 平台检测 ✓');
}

// X2: WSL → Windows backend（powershell SoundPlayer + wslpath 转换）
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const backend = createWavBackend({
		platform: 'wsl',
		directory: '/home/u/.config/dsh/notify-bell/sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: (cmd, args) => {
			check(cmd === 'wslpath', 'X2 wslpath used', cmd);
			return { status: 0, stdout: Buffer.from('\\\\wsl.localhost\\Ubuntu\\home\\u\\done.wav') };
		},
		existsSync: () => true,
		bell: fakeBell
	});
	backend.play('done');
	check(spawned.length === 1, 'X2 spawn powershell', spawned.length);
	check(spawned[0].cmd === 'powershell.exe', 'X2 powershell cmd', spawned[0]?.cmd);
	const script = (spawned[0]?.args ?? []).join(' ');
	check(script.includes('System.Media.SoundPlayer') && script.includes('wsl.localhost'), 'X2 soundplayer + converted path', script);
	check(fakeBell.playCalls.length === 0, 'X2 no fallback', fakeBell.playCalls);
	report('X2: WSL → Windows backend ✓');
}

// X3: Windows native → Windows backend（不调用 wslpath）
{
	const spawned = [];
	const wslpathCalls = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const backend = createWavBackend({
		platform: 'windows',
		directory: 'C:\\Users\\me\\.config\\dsh\\notify-bell\\sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: (cmd, args) => { wslpathCalls.push(cmd); return { status: 0, stdout: Buffer.from('C:\\x.wav') }; },
		existsSync: () => true,
		bell: { play: () => {}, dispose: () => {} }
	});
	backend.play('done');
	check(spawned.length === 1, 'X3 spawn powershell', spawned.length);
	const script = (spawned[0]?.args ?? []).join(' ');
	check(script.includes('C:\\Users\\me') || script.includes('Users\\me'), 'X3 native windows path used', script);
	check(wslpathCalls.length === 0, 'X3 no wslpath on windows', wslpathCalls);
	report('X3: Windows native → Windows backend（无 wslpath）✓');
}

// X4: Linux → Linux backend（paplay 播放本地路径）
{
	const spawned = [];
	const fakeSpawn = (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; };
	const backend = createWavBackend({
		platform: 'linux',
		directory: '/home/u/sounds',
		player: { cmd: 'paplay', buildArgs: (target) => [target] },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('') }),
		existsSync: () => true,
		bell: { play: () => {}, dispose: () => {} }
	});
	backend.play('error');
	check(spawned.length === 1 && spawned[0].cmd === 'paplay', 'X4 paplay spawn', spawned[0]);
	check((spawned[0]?.args ?? []).join(' ').includes('/home/u/sounds/error.wav'), 'X4 native linux path', spawned[0]?.args);
	report('X4: Linux → Linux backend ✓');
}

// X5: Linux 找不到播放器 → BEL
{
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const backend = createWavBackend({
		platform: 'linux',
		directory: '/home/u/sounds',
		player: null,
		spawn: () => { throw new Error('must not spawn'); },
		spawnSync: () => ({ status: 0, stdout: Buffer.from('') }),
		existsSync: () => true,
		bell: fakeBell
	});
	backend.play('block');
	check(fakeBell.playCalls[0] === 'block', 'X5 fallback bell', fakeBell.playCalls);
	report('X5: Linux 无播放器 → BEL ✓');
}

// X6: Windows SoundPlayer 失败（非零退出）→ BEL
{
	const spawned = [];
	const handlersMap = {};
	const fakeSpawn = (cmd, args) => {
		const child = { on: (e, h) => { handlersMap[e] = h; return child; } };
		spawned.push({ cmd, args });
		return child;
	};
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const backend = createWavBackend({
		platform: 'windows',
		directory: 'C:\\sounds',
		player: { cmd: 'powershell.exe' },
		spawn: fakeSpawn,
		spawnSync: () => ({ status: 0, stdout: Buffer.from('C:\\s.wav') }),
		existsSync: () => true,
		bell: fakeBell
	});
	backend.play('done');
	handlersMap.exit?.(1);
	check(fakeBell.playCalls.length === 1 && fakeBell.playCalls[0] === 'done', 'X6 soundplayer failure -> BEL', fakeBell.playCalls);
	report('X6: Windows SoundPlayer 失败 → BEL ✓');
}

// X7: Linux 真实 subprocess（不注入 spawn）：可执行文件不存在 → 真实 ENOENT error → BEL
{
	const fakeBell = { playCalls: [], play: (sound) => fakeBell.playCalls.push(sound), dispose: () => {} };
	const backend = createWavBackend({
		platform: 'linux',
		directory: '/home/u/sounds',
		player: { cmd: 'definitely-not-a-real-player-xyz', buildArgs: (target) => [target] },
		existsSync: () => true,
		bell: fakeBell
	});
	backend.play('done');
	await sleep(150);
	check(fakeBell.playCalls.length === 1 && fakeBell.playCalls[0] === 'done', 'X7 real spawn ENOENT -> BEL', fakeBell.playCalls);
	report('X7: Linux 真实 subprocess 缺失 → error → BEL ✓');
}

// X8: 播放器探测函数（环境自适应：powershell 必有；Linux 播放器属候选集——本机 ffmpeg 自带 ffplay）
{
	check(detectWindowsPlayer() !== null, 'X8 windows player detected', detectWindowsPlayer());
	const linuxPlayer = detectLinuxPlayer();
	check(linuxPlayer === null || ['paplay', 'pw-play', 'aplay', 'ffplay'].includes(linuxPlayer.cmd), 'X8 linux player in candidate set', linuxPlayer);
	check(detectPlayerFor('windows') !== null, 'X8 windows probe found', detectPlayerFor('windows'));
	check(detectPlayerFor('other') === null, 'X8 other probe null', detectPlayerFor('other'));
	report('X8: 播放器探测（环境自适应）✓');
}

// ---------- Y: v8 Web 铃铛开关 新增 ----------
// Y1: writeEnabled 文件不存在 → 创建最小配置
{
	const dir = mkdtempSync(join(tmpdir(), 'nb-y1-'));
	const file = join(dir, 'nb.json');
	writeEnabled(file, false);
	const cfg = JSON.parse(readFileSync(file, 'utf8'));
	check(cfg.enabled === false, 'Y1 created with enabled=false', cfg);
	rmSync(dir, { recursive: true, force: true });
	report('Y1: writeEnabled 不存在创建 ✓');
}

// Y2: writeEnabled 保留其他字段
{
	const dir = mkdtempSync(join(tmpdir(), 'nb-y2-'));
	const file = join(dir, 'nb.json');
	writeFileSync(file, JSON.stringify({ soundPack: 'wav', enabled: true, events: { complete: { sound: 'done' } }, wav: { directory: '/x', fallback: 'bell' } }));
	writeEnabled(file, false);
	const cfg = JSON.parse(readFileSync(file, 'utf8'));
	check(cfg.enabled === false, 'Y2 enabled updated', cfg.enabled);
	check(cfg.soundPack === 'wav' && cfg.events.complete.sound === 'done' && cfg.wav.fallback === 'bell' && cfg.wav.directory === '/x', 'Y2 other fields preserved', cfg);
	rmSync(dir, { recursive: true, force: true });
	report('Y2: writeEnabled 保留其他字段 ✓');
}

// Y3: 非法 JSON → 抛错且文件不变
{
	const dir = mkdtempSync(join(tmpdir(), 'nb-y3-'));
	const file = join(dir, 'nb.json');
	writeFileSync(file, '{{{ not json');
	let threw = null;
	try { writeEnabled(file, true); } catch (error) { threw = error.message; }
	check(threw !== null && threw.includes('not valid JSON'), 'Y3 throws on invalid JSON', threw);
	check(readFileSync(file, 'utf8') === '{{{ not json', 'Y3 file unchanged', readFileSync(file, 'utf8'));
	rmSync(dir, { recursive: true, force: true });
	report('Y3: 非法 JSON 抛错 + 文件不变 ✓');
}

// Y4-Y8: HTTP API（mock webServer 捕获路由）
function setupWithWeb(configObj, rpcOptions = {}) {
	const s = setup(configObj);
	let route;
	const webServer = { register: (r) => { route = r; } };
	s.ctx.inject = (names, cb) => {
		if (names.includes('webServer')) cb({ webServer });
	};
	s.applyPlugin({ ...rpcOptions });
	const call = async (endpoint, args, method = 'POST') => {
		const body = args === undefined ? '' : JSON.stringify(args);
		const req = {
			method,
			url: endpoint === 'getEnabled' ? '/notify-bell' : '/notify-bell/' + endpoint,
			[Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(body); }
		};
		let status;
		let payload = '';
		const res = {
			writeHead: (code) => { status = code; },
			end: (text) => { payload = text; }
		};
		await route.handler(req, res);
		return { status, ...JSON.parse(payload) };
	};
	return { ...s, call };
}

// Y4: getEnabled（GET /notify-bell）
{
	const s = setupWithWeb({ enabled: true, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const r = await s.call('getEnabled', undefined, 'GET');
	check(r.ok === true && r.value.enabled === true, 'Y4 getEnabled', r);
	rmSync(s.dir, { recursive: true, force: true });
	report('Y4: HTTP getEnabled ✓');
}

// Y5: setEnabled(false) → 持久化 + 同一实例立即生效（integration）
{
	const s = setupWithWeb({ enabled: true, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const r = await s.call('setEnabled', { enabled: false });
	check(r.ok === true && r.value.enabled === false, 'Y5 setEnabled ok', r);
	const cfg = JSON.parse(readFileSync(s.file, 'utf8'));
	check(cfg.enabled === false && cfg.bell.gapMs === GAP, 'Y5 persisted (other fields kept)', cfg);
	// 同一实例：后续 complete 不通知（无需重启）
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0 && s.logLines().length === 0, 'Y5 runtime disabled immediately', s.writes);
	// 重新启用后恢复（DSH turn 号单调递增，这里用 turn 2 模拟下一轮）
	await s.call('setEnabled', { enabled: true });
	completeTurn(s, 2, { startAgoMs: 30_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'Y5 re-enabled works', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('Y5: setEnabled 持久化 + 运行时立即生效 ✓');
}

// Y6: toggle 翻转
{
	const s = setupWithWeb({ enabled: true, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const r1 = await s.call('toggle');
	check(r1.ok && r1.value.enabled === false, 'Y6 toggle off', r1);
	const r2 = await s.call('toggle');
	check(r2.ok && r2.value.enabled === true, 'Y6 toggle on', r2);
	rmSync(s.dir, { recursive: true, force: true });
	report('Y6: HTTP toggle ✓');
}

// Y7: setEnabled 非布尔 → bad-request
{
	const s = setupWithWeb({ enabled: true, bell: { gapMs: GAP, permissionGapMs: GAP } });
	const r = await s.call('setEnabled', { enabled: 'yes' });
	check(r.ok === false && r.error.code === 'bad-request', 'Y7 bad request', r);
	rmSync(s.dir, { recursive: true, force: true });
	report('Y7: 非布尔参数 → bad-request ✓');
}

// Y8: 写配置失败 → write-failed + 运行时状态不变（UI 回滚一致）
{
	const s = setupWithWeb({ enabled: true, bell: { gapMs: GAP, permissionGapMs: GAP } }, {
		writeEnabled: () => { throw new Error('disk full'); }
	});
	const r = await s.call('setEnabled', { enabled: false });
	check(r.ok === false && r.error.code === 'write-failed', 'Y8 write-failed', r);
	const still = await s.call('getEnabled', undefined, 'GET');
	check(still.ok && still.value.enabled === true, 'Y8 runtime state unchanged', still);
	rmSync(s.dir, { recursive: true, force: true });
	report('Y8: 写失败 → write-failed + 状态不变 ✓');
}

// Y9-Y12: client bundle（模拟浏览器 __ModuleLoader__ 加载）
{
	// 模拟 window.__ModuleLoader__：捕获 load 规格，factory 用 mock react 执行。
	const specs = [];
	globalThis.window = { __ModuleLoader__: { load: (spec) => specs.push(spec) } };
	const reactMock = await import('./mock-react.mjs');
	await import('./client.js');
	const spec = specs[specs.length - 1];
	check(spec && spec.id === 'dsh-notify-bell', 'Y9 loader id', spec?.id);
	const loaded = spec.factory((name) => {
		if (name === 'react') return reactMock;
		throw new Error('unexpected require: ' + name);
	});

	// Y9: bellView 纯函数（图标/文案/title/aria）
	const { bellView } = loaded;
	const on = bellView(true);
	check(on.icon === 'bell' && on.label === 'Disable notifications' && on.title === 'Disable notifications' && on.pressed === true, 'Y9 enabled view', on);
	const off = bellView(false);
	check(off.icon === 'bell-slash' && off.label === 'Enable notifications' && off.title === 'Enable notifications' && off.pressed === false, 'Y9 disabled view', off);
	const err = bellView(true, true);
	check(err.title === 'Failed to update notifications setting', 'Y9 error title', err);
	const loading = bellView(null);
	check(loading.ready === false, 'Y9 loading state', loading);
	report('Y9: bellView 纯函数 ✓');

	// Y10: bellRpc（mock fetch）
	const { bellRpc } = loaded;
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		calls.push({ url, opts });
		return { ok: true, json: async () => ({ ok: true, value: { enabled: false } }) };
	};
	const ok = await bellRpc('toggle');
	check(ok.ok && ok.value.enabled === false, 'Y10 rpc success', ok);
	check(calls[0].url === '/notify-bell/toggle' && calls[0].opts.method === 'POST', 'Y10 rpc url/method', calls[0]);
	globalThis.fetch = realFetch;
	report('Y10: bellRpc ✓');

	// Y11: apply 注册 slots（style effect + bell entry）
	const effects = [];
	let injectedName = null;
	let regOpts = null;
	let regComp = null;
	globalThis.document = {
		createElement: () => ({ setAttribute() {}, remove() {} }),
		head: { append() {} }
	};
	const mockCtx = {
		effect: (fn) => { effects.push(fn); fn(); return () => {}; },
		slots: {
			inject: (name, cb) => { injectedName = name; cb(); return () => {}; },
			register: (opts, comp) => { regOpts = opts; regComp = comp; return () => {}; }
		}
	};
	loaded.apply(mockCtx);
	check(effects.length === 2, 'Y11 two effects', effects.length);
	check(injectedName === 'conversation.session.header.utilities', 'Y11 slot name', injectedName);
	check(regOpts?.id === 'notify-bell-toggle' && regOpts?.name === 'conversation.session.header.utilities' && regOpts?.order === 90, 'Y11 register opts', regOpts);
	check(typeof regComp === 'function', 'Y11 component registered', typeof regComp);
	report('Y11: apply 注册 slots ✓');

	// Y12: client.js 打包格式（__ModuleLoader__ + 无相对导入 + require react）
	const source = readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8');
	check(source.includes('window.__ModuleLoader__.load'), 'Y12 module loader format', 'client.js');
	check(!/\.\//.test(source), 'Y12 no relative imports', 'client.js');
	check(source.includes('require("react")'), 'Y12 require react', 'client.js');
	report('Y12: client.js 打包格式 ✓');

	delete globalThis.window;
	delete globalThis.document;
}

// ---------- Q: v9 question 通知 新增 ----------
// Q1: 真实 question event（tool/call + ask_user_question）→ question sound（WAV 配置下播 question.wav）
{
	const spawned = [];
	const s = setup({ soundPack: 'wav', wav: { directory: '/tmp/sounds' }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	apply(s.ctx, {}, {
		configPath: s.file,
		write: (c) => s.writes.push({ t: Date.now(), c: String(c) }),
		isTTY: () => tty,
		warn: (m) => s.warns.push(m),
		spawn: (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; },
		existsSync: () => true,
		player: { cmd: 'powershell.exe' }
	});
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 3, step: 1, callId: 'call-q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要继续吗？', options: [{ label: '是' }, { label: '否' }] }] }) }
	});
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ❓ question: 要继续吗？ (2 options)', 'Q1 question log', l);
	check(spawned.length === 1 && spawned[0].args.join(' ').includes('question.wav'), 'Q1 question.wav played', spawned.map((x) => x.args.join(' ')));
	rmSync(s.dir, { recursive: true, force: true });
	report('Q1: 真实 question 事件 → question sound ✓');
}

// Q2: question.sound 默认值为 "question"（配置层）
{
	check(DEFAULT_CONFIG.events.question.sound === 'question', 'Q2 default sound', DEFAULT_CONFIG.events.question.sound);
	check(DEFAULT_CONFIG.events.question.enabled === true, 'Q2 default enabled', DEFAULT_CONFIG.events.question.enabled);
	check(SEMANTIC_SOUNDS.includes('question'), 'Q2 vocabulary includes question', SEMANTIC_SOUNDS);
	report('Q2: question.sound 默认值 ✓');
}

// Q3: question enabled=false → 不通知
{
	const s = setup({ events: { question: { enabled: false } }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q3', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'x' }] }) }
	});
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'Q3 question disabled silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('Q3: question enabled=false ✓');
}

// Q4: question → notification/info WAV 映射（audio.js SOUND_FILES）
{
	const { SOUND_FILES } = await import('./audio.js');
	check(SOUND_FILES.question === 'question.wav', 'Q4 question.wav mapping', SOUND_FILES.question);
	// 其余四个保持不变
	check(SOUND_FILES.done === 'done.wav' && SOUND_FILES.permission === 'permission.wav' && SOUND_FILES.block === 'block.wav' && SOUND_FILES.error === 'error.wav', 'Q4 other sounds unchanged', SOUND_FILES);
	report('Q4: question → question.wav（其他不变）✓');
}

// Q5: default soundPack → question = 2 BEL
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } }); // soundPack 默认 default
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q5', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'y' }] }) }
	});
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'Q5 question 2 BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('Q5: default pack → question 2 BEL ✓');
}

// Q6: 重复 question event（同 session+callId）→ 只通知一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const evt = {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q6', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'z' }] }) }
	};
	s.emit('session/event', MOCK_SESSION, evt);
	s.emit('session/event', MOCK_SESSION, evt); // 重复（如重放）
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'Q6 one notification (2 BEL)', s.bells());
	check(s.logLines().length === 1, 'Q6 one log', s.logLines());
	// 不同 callId → 新通知
	s.emit('session/event', MOCK_SESSION, { ...evt, data: { ...evt.data, callId: 'call-q6b' } });
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 4, 'Q6 different callId notifies again', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('Q6: 重复 question 只通知一次 ✓');
}

// Q7: 回答后（tool/result / question/resolved）→ 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'yes' }] } } });
	s.emit('session/event', MOCK_SESSION, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c-r', name: 'bash', arguments: '{}' } }); // 非 ask_user_question
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'Q7 answered/other tool silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('Q7: 回答后不通知 ✓');
}

// Q8: question text 截断（maxLength 复用）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const longQ = '字'.repeat(150);
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q8', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: longQ }] }) }
	});
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	const textPart = l[0]?.split(': ')[1];
	check(textPart?.length === 121 && textPart.endsWith('…') && textPart.slice(0, 120) === '字'.repeat(120), 'Q8 truncated 120+…', textPart?.length);
	rmSync(s.dir, { recursive: true, force: true });
	report('Q8: question text 截断 ✓');
}

// Q9: question 缺少 text → 无 undefined/null
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q9', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q' }] }) }
	});
	await sleep(GAP * 3 + 30);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ❓ question: (question)', 'Q9 missing text fallback', l);
	check(!l[0].includes('undefined') && !l[0].includes('null'), 'Q9 no undefined/null leak', l[0]);
	rmSync(s.dir, { recursive: true, force: true });
	report('Q9: 缺 text 无 undefined/null ✓');
}

// Q10: 非 TTY（WAV 播放照常 / BEL fallback 不响）+ enabled=false 全局静音
{
	// 非 TTY + default pack：question fallback 的 BEL 不响，日志保留
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	tty = false;
	s.applyPlugin();
	s.emit('session/event', MOCK_SESSION, {
		type: 'tool/call',
		data: { turn: 1, step: 1, callId: 'call-q10', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 't' }] }) }
	});
	await sleep(GAP * 3 + 30);
	tty = true;
	check(s.bells().length === 0, 'Q10 non-TTY no BEL', s.bells());
	check(s.logLines().length === 1, 'Q10 log kept', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('Q10: 非 TTY 行为保持 ✓');
}

// ---------- S: 官方 Config schema + 配置合并（v0.10 规范化） ----------
// S1: Config({}) 默认值与 DEFAULT_CONFIG 完全一致
{
	const fromSchema = JSON.parse(JSON.stringify(Config({})));
	check(JSON.stringify(fromSchema) === JSON.stringify(DEFAULT_CONFIG), 'S1 schema defaults == DEFAULT_CONFIG', fromSchema);
	report('S1: Config schema 默认值 == DEFAULT_CONFIG ✓');
}

// S2: Config fail loudly（非法配置抛 ValidationError，而非静默回退）
{
	let threw = false;
	try { Config({ soundPack: 'webhook' }); } catch { threw = true; }
	check(threw, 'S2 invalid soundPack throws', threw);
	let threw2 = false;
	try { Config({ events: { complete: { sound: 'nope' } } }); } catch { threw2 = true; }
	check(threw2, 'S2 invalid sound throws', threw2);
	let threw3 = false;
	try { Config({ minDuration: 'abc' }); } catch { threw3 = true; }
	check(threw3, 'S2 invalid minDuration throws', threw3);
	report('S2: Config schema fail loudly ✓');
}

// S3: Config 填默认 + 保留合法值（对象校验）
{
	const c = Config({ enabled: false, events: { complete: { sound: 'block' } }, bell: { gapMs: 200 } });
	check(c.enabled === false && c.minDuration === 10, 'S3 keeps value + fills default', c);
	check(c.events.complete.sound === 'block' && c.events.block.sound === 'block', 'S3 event sound kept/default', c);
	check(c.events.question.sound === 'question' && c.bell.gapMs === 200 && c.bell.permissionGapMs === 300, 'S3 nested defaults', c);
	check(c.soundPack === 'default' && c.wav.fallback === 'bell', 'S3 union defaults', c);
	report('S3: Config 填默认 + 保留合法值 ✓');
}

// S4: explicitFields 只提取与默认不同的字段
{
	check(JSON.stringify(explicitFields({})) === '{}', 'S4 empty config → no explicit fields', explicitFields({}));
	check(JSON.stringify(explicitFields(Config({}))) === '{}', 'S4 schema-filled defaults → no explicit fields', explicitFields(Config({})));
	const e = explicitFields(Config({ minDuration: 5, events: { question: { sound: 'error' } } }));
	check(JSON.stringify(e) === JSON.stringify({ minDuration: 5, events: { question: { sound: 'error' } } }), 'S4 explicit diff only', e);
	const e2 = explicitFields(Config({ enabled: false }));
	check(JSON.stringify(e2) === JSON.stringify({ enabled: false }), 'S4 enabled explicit', e2);
	report('S4: explicitFields 差异提取 ✓');
}

// S5: mergeConfig 优先级（cordis 显式 > 文件 > 默认）
{
	const fileCfg = sanitizeConfig({ enabled: false, minDuration: 3, events: { complete: { sound: 'permission' } } });
	// 文件生效：cordis 无显式字段
	const m1 = mergeConfig(Config({}), fileCfg);
	check(m1.enabled === false && m1.minDuration === 3 && m1.events.complete.sound === 'permission', 'S5 file layer wins over defaults', m1);
	// cordis 显式覆盖文件
	const m2 = mergeConfig(Config({ minDuration: 60 }), fileCfg);
	check(m2.minDuration === 60 && m2.enabled === false, 'S5 explicit cordis wins over file', m2);
	// 深层覆盖
	const m3 = mergeConfig(Config({ events: { complete: { sound: 'error' } } }), fileCfg);
	check(m3.events.complete.sound === 'error' && m3.events.block.sound === 'block', 'S5 deep explicit wins', m3);
	// 文件 bellCount 兼容仍在（经 sanitize）
	const m4 = mergeConfig(Config({}), sanitizeConfig({ events: { complete: { bellCount: 1 }, block: { bellCount: 2 } } }));
	check(m4.events.complete.sound === 'done' && m4.events.block.sound === 'permission', 'S5 bellCount legacy kept', m4);
	report('S5: mergeConfig 优先级 ✓');
}

// S6: apply 第二参数（cordis config）显式字段生效（行为级）
{
	const s = setup({ minDuration: 10, bell: { gapMs: GAP, permissionGapMs: GAP } });
	apply(s.ctx, { minDuration: 100000 }, {
		configPath: s.file,
		write: (c) => s.writes.push({ t: Date.now(), c: String(c) }),
		isTTY: () => tty,
		warn: (m) => s.warns.push(m)
	});
	// 30s 的 complete：cordis 显式 minDuration=100000s → 不响（仅日志）
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'S6 cordis minDuration honored', s.bells());
	check(s.logLines().length === 1, 'S6 log still emitted', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('S6: apply 第二参数（cordis 显式配置）生效 ✓');
}

// ---------- T: v0.11 final-answer completion（turn/end 语义） ----------
// T1: turn/start → user/message → assistant/message(final text) → turn/end(completed) → complete 通知（日志 + done 1 BEL）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T1 one BEL', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (30s): 为 deepseek harness 制作通知插件 (turn #1)', 'T1 log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T1: turn/end completed → complete ✓');
}

// T2-T6: 非 completed 的 turn/end 一律不通知
{
	for (const [reason, label] of [['interrupted', 'T2'], ['aborted', 'T3'], ['error', 'T4'], ['blocked', 'T5'], ['max-tokens', 'T6']]) {
		const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
		s.applyPlugin();
		const t0 = Date.now() - 30_000;
		s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
		s.emit('session/event', MAIN_SESSION, turnUserMsg(1, '任务', t0 + 5));
		s.emit('session/event', MAIN_SESSION, assistantText(1, '本应有最终回答', Date.now() - 1_000));
		s.emit('session/event', MAIN_SESSION, turnEnd(1, reason, Date.now()));
		await sleep(GAP * 2 + 20);
		check(s.bells().length === 0 && s.logLines().length === 0, label + ' ' + reason + ' silent', s.writes);
		rmSync(s.dir, { recursive: true, force: true });
		report(label + ': turn/end(' + reason + ') 不通知 ✓');
	}
}

// T7: duration < minDuration → 日志，无声音
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 2_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'T7 no BEL', s.bells());
	check(s.logLines().length === 1 && s.logLines()[0].includes('✓ completed (2s)'), 'T7 log kept', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T7: 短请求（<minDuration）只日志 ✓');
}

// T8: duration >= minDuration → done
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 60_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T8 one BEL', s.bells());
	check(s.logLines()[0].includes('✓ completed (60s)'), 'T8 duration logged', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T8: 长请求（>=minDuration）播放 done ✓');
}

// T9: 重复 turn/end → 只通知一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now() + 100));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now() + 200));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T9 one BEL', s.bells());
	check(s.logLines().length === 1, 'T9 one log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T9: 重复 turn/end 只通知一次 ✓');
}

// T10: 同 turn 内部事件（step/chunk/tool）不影响完成通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(1, '任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, { type: 'step/start', time: t0 + 100, data: { turn: 1, step: 1 } });
	s.emit('session/event', MAIN_SESSION, { type: 'assistant/chunk', time: t0 + 200, data: { turn: 1, step: 1, chunk: { type: 'text', text: 'x' } } });
	s.emit('session/event', MAIN_SESSION, { type: 'tool/call', time: t0 + 300, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } });
	s.emit('session/event', MAIN_SESSION, { type: 'step/end', time: t0 + 400, data: { turn: 1, step: 1 } });
	s.emit('session/event', MAIN_SESSION, assistantText(1, '最终回答', t0 + 500));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T10 one BEL', s.bells());
	check(s.logLines().length === 1, 'T10 one log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T10: turn 内部事件不重复通知 ✓');
}

// T11: approval 在 turn 内 → permission 立即 + 最终 complete
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(1, '任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, approvalEvent({ id: 'req-1' }));
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'T11 permission first (2 BEL)', s.bells());
	s.emit('session/event', MAIN_SESSION, assistantText(1, '已获批准，任务完成', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 3, 'T11 permission + done', s.bells());
	const l = s.logLines();
	check(l.length === 2 && l[0].includes('🔐 approval') && l[1].includes('✓ completed'), 'T11 both logs', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T11: approval + complete 联动 ✓');
}

// T12: question 在 turn 内 → question 立即 + 最终 complete
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(1, '任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, {
		type: 'tool/call',
		time: t0 + 100,
		data: { turn: 1, step: 1, callId: 'call-q', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: '要继续吗？', options: ['是', '否'] }] }) }
	});
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'T12 question first (2 BEL)', s.bells());
	s.emit('session/event', MAIN_SESSION, assistantText(1, '收到答案，任务完成', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 3, 'T12 question + done', s.bells());
	const l = s.logLines();
	check(l.length === 2 && l[0].includes('❓ question') && l[1].includes('✓ completed'), 'T12 both logs', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T12: question + complete 联动 ✓');
}

// T13: 子会话（delegationDepth=1）turn/end completed → 无任何输出
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', SUB_SESSION, turnStart(1, t0));
	s.emit('session/event', SUB_SESSION, turnUserMsg(1, '子代理任务', t0 + 5));
	s.emit('session/event', SUB_SESSION, assistantText(1, '子代理最终回答', Date.now() - 1_000));
	s.emit('session/event', SUB_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'T13 subagent silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('T13: 子代理 turn 不触发 complete ✓');
}

// T14: 主会话（delegationDepth=0）正常 complete
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1 && s.bells().length === 1, 'T14 main session works', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('T14: 主会话 delegationDepth=0 ✓');
}

// T15: 连续两个 turn → 各自独立计时、各自一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 30_000, text: '第一个请求' });
	completeTurn(s, 2, { startAgoMs: 5_000, text: '第二个请求' });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T15 first long -> BEL, second short -> no BEL', s.bells());
	const l = s.logLines();
	check(l.length === 2 && l[0].includes('第一个请求') && l[1].includes('第二个请求'), 'T15 two independent turns', l);
	// 第三个独立 turn（长）→ 第二个 BEL（turn 2 短请求已被去重记录）
	completeTurn(s, 3, { startAgoMs: 30_000, text: '第三个请求' });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 2, 'T15 third turn long -> BEL', s.bells());
	check(s.logLines().length === 3, 'T15 three logs', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T15: 多 turn 独立计时/去重 ✓');
}

// T16: 缺 turn/start + 有最终 assistant text → 只日志（unknown duration），不播放
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MAIN_SESSION, assistantText(58, '最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(58, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'T16 no BEL without start', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed: turn #58', 'T16 unknown duration log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T16: 缺 turn/start 只日志不播放 ✓');
}

// T17: 首条 user/message 作为摘要
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '请修复进度条卡顿' });
	await sleep(GAP * 2 + 20);
	check(s.logLines()[0].includes('请修复进度条卡顿'), 'T17 summary used', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T17: user message 摘要 ✓');
}

// T18a: no-op 空 turn（无 user/message、无 assistant/message）→ 完全静默
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeNoOpTurn(s, 3, { startAgoMs: 30_000 });
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'T18a no-op turn completely silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('T18a: 空 claim no-op 完全静默 ✓');
}

// T18b: 无 user/message 但有最终 assistant text → fallback "turn #N" 并正常通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(3, t0));
	s.emit('session/event', MAIN_SESSION, assistantText(3, '自动轮次最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(3, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (30s): turn #3', 'T18b fallback turn #N', l);
	check(s.bells().length === 1, 'T18b one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('T18b: 无 user message 但有最终 assistant text ✓');
}

// T19: user message 超过 maxLength → 截断
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '字'.repeat(150) });
	await sleep(GAP * 2 + 20);
	const summary = s.logLines()[0]?.split(': ')[1]?.split(' (turn #')[0];
	check(summary?.length === 121 && summary.endsWith('…'), 'T19 truncated', summary?.length);
	rmSync(s.dir, { recursive: true, force: true });
	report('T19: user message 截断 ✓');
}

// T20: 多行 user message → 单行
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '第一行\n第二行   \n\n第三行' });
	await sleep(GAP * 2 + 20);
	check(s.logLines()[0].includes('第一行 第二行 第三行'), 'T20 single line', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T20: 多行转单行 ✓');
}

// T21: goal/changed complete → 不再播放 done、无日志
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('complete', goalView('complete', { createdAtMs: Date.now() - 60_000 })) });
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'T21 goal complete silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('T21: goal complete 不再触发 done ✓');
}

// T22: goal/changed block → 仍然播放 block
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('goal/changed', { change: goalChange('block', goalView('blocked')) });
	await sleep(GAP * 3 + 30);
	check(s.bells().length === 2, 'T22 block 2 BEL', s.bells());
	check(s.logLines()[0].includes('⚠ blocked'), 'T22 block log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T22: goal block 语义保留 ✓');
}

// T23: WAV backend → complete 播放 done.wav
{
	const spawned = [];
	const s = setup({ soundPack: 'wav', wav: { directory: '/tmp/sounds' }, bell: { gapMs: GAP, permissionGapMs: GAP } });
	apply(s.ctx, {}, {
		configPath: s.file,
		write: (c) => s.writes.push({ t: Date.now(), c: String(c) }),
		isTTY: () => tty,
		warn: (m) => s.warns.push(m),
		spawn: (cmd, args) => { spawned.push({ cmd, args }); return { on: () => {} }; },
		existsSync: () => true,
		player: { cmd: 'powershell.exe' }
	});
	completeTurn(s, 1);
	await sleep(GAP * 2 + 20);
	check(spawned.length === 1 && spawned[0].args.join(' ').includes('done.wav'), 'T23 done.wav played', spawned.map((x) => x.args.join(' ')));
	rmSync(s.dir, { recursive: true, force: true });
	report('T23: WAV complete → done.wav ✓');
}

// T24: BEL backend → complete 用 done → 1 BEL
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 60_000 });
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T24 done -> 1 BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('T24: BEL complete → 1 声 ✓');
}

// T25: 真实主会话 header 无 delegationDepth（C1 回归）→ 正常 complete
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	// 活主会话形态：header 没有 delegationDepth 字段
	const liveMain = { id: 'session-live', header: { id: 'session-live' } };
	const t0 = Date.now() - 30_000;
	s.emit('session/event', liveMain, turnStart(1, t0));
	s.emit('session/event', liveMain, turnUserMsg(1, '真实主会话', t0 + 5));
	s.emit('session/event', liveMain, assistantText(1, '最终回答', Date.now() - 1_000));
	s.emit('session/event', liveMain, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T25 live main session -> BEL', s.bells());
	check(s.logLines().length === 1 && s.logLines()[0].includes('真实主会话'), 'T25 log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T25: 无 delegationDepth 主会话正常通知 ✓');
}

// T26: interrupted 后同 turn 重放 completed → 不误报"完成"（M1 回归：状态已消费）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'interrupted', t0 + 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'T26 interrupted+completed replay completely silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('T26: interrupted 后重放 completed 不误报 ✓');
}

// T27: 双 session 交错（主 + 子）→ 各自独立、子代理被排除
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { text: '主会话请求' });
	const t0 = Date.now() - 30_000;
	s.emit('session/event', SUB_SESSION, turnStart(1, t0));
	s.emit('session/event', SUB_SESSION, turnUserMsg(1, '子代理任务', t0 + 5));
	s.emit('session/event', SUB_SESSION, assistantText(1, '子代理最终回答', Date.now() - 1_000));
	s.emit('session/event', SUB_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 1, 'T27 only main BEL', s.bells());
	check(s.logLines().length === 1 && s.logLines()[0].includes('主会话请求'), 'T27 only main log', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T27: 双 session 交错隔离 ✓');
}

// T28: user/message 先于 turn/start → 丢弃（无摘要，fallback）
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnUserMsg(1, '过早的消息', t0 - 5_000));
	s.emit('session/event', MAIN_SESSION, turnStart(1, t0));
	s.emit('session/event', MAIN_SESSION, assistantText(1, '最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (30s): turn #1', 'T28 early user message dropped', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T28: 先于 turn/start 的 user/message 丢弃 ✓');
}

// T29: turn/start 缺 event.time → duration null → 只日志不响
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MAIN_SESSION, { type: 'turn/start', data: { turn: 7 } });
	s.emit('session/event', MAIN_SESSION, turnUserMsg(7, '无时间', Date.now()));
	s.emit('session/event', MAIN_SESSION, assistantText(7, '最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(7, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'T29 no BEL without start time', s.bells());
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed: 无时间 (turn #7)', 'T29 unknown duration log', l);
	rmSync(s.dir, { recursive: true, force: true });
	report('T29: turn/start 缺 event.time 只日志 ✓');
}

// T30: 短 turn 后重复 turn/end → 仍只日志一次、不响
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 2_000 });
	s.emit('session/event', MAIN_SESSION, turnEnd(1, 'completed', Date.now() + 100));
	await sleep(GAP * 2 + 20);
	check(s.bells().length === 0, 'T30 no BEL (short + dedupe)', s.bells());
	check(s.logLines().length === 1, 'T30 one log only', s.logLines());
	rmSync(s.dir, { recursive: true, force: true });
	report('T30: 短 turn 重复 turn/end 只一次日志 ✓');
}

// ---------- C1: 严格 final assistant text 判定 ----------
// C1-1: 空 claim no-op（无任何 message）→ 无日志、无声音
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeNoOpTurn(s, 1, { startAgoMs: 30_000 });
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-1 no-op turn completely silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-1: 空 claim no-op 完全静默 ✓');
}

// C1-2: 正常 user message + assistant final text → 正常 done
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 1, { startAgoMs: 30_000, text: '正常用户请求', finalText: '正常最终回答' });
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	check(l.length === 1 && l[0].includes('正常用户请求') && l[0].includes('✓ completed (30s)'), 'C1-2 log', l);
	check(s.bells().length === 1, 'C1-2 one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-2: 正常 final text 触发 done ✓');
}

// C1-3: goal 自动续跑轮次（source.kind=goal，无 human user/message）+ final text → 正常 done
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeGoalRound(s, 1, { startAgoMs: 30_000 });
	await sleep(GAP * 2 + 20);
	const l = s.logLines();
	check(l.length === 1 && l[0] === '[notify-bell] ✓ completed (30s): turn #1', 'C1-3 goal round fallback log', l);
	check(s.bells().length === 1, 'C1-3 one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-3: goal round + final text 正常 done ✓');
}

// C1-4: assistant/message(tool-call only) + tool/call + tool/result + turn/end(completed) → 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(4, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(4, '执行工具', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantMessage(4, [toolCallBlock('c4', 'finish_tool')], t0 + 10));
	s.emit('session/event', MAIN_SESSION, toolCall(4, 'c4', 'finish_tool', t0 + 20));
	s.emit('session/event', MAIN_SESSION, toolResult(4, 'c4', t0 + 30));
	s.emit('session/event', MAIN_SESSION, turnEnd(4, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-4 tool-call-only concludesTurn silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-4: tool-call-only concludesTurn 不通知 ✓');
}

// C1-5: assistant text 之后又出现 tool/call，turn/end(completed) 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(5, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(5, '先回答再工具', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(5, '这不是最终回答', t0 + 10));
	s.emit('session/event', MAIN_SESSION, toolCall(5, 'c5', 'finish_tool', t0 + 20));
	s.emit('session/event', MAIN_SESSION, toolResult(5, 'c5', t0 + 30));
	s.emit('session/event', MAIN_SESSION, turnEnd(5, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-5 text-before-toolcall completed silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-5: 文本后又出现 tool/call 不通知 ✓');
}

// C1-6: 最终 assistant text 后没有 tool/call → 通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(6, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(6, '正常任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(6, '真正的最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(6, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1 && s.bells().length === 1, 'C1-6 final text without toolcall notifies', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-6: 最终文本后无 tool/call 通知 ✓');
}

// C1-7: 多个 assistant/message（tool-call-only → final text）→ 只通知一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(7, t0, 10));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(7, '多步任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantMessage(7, [toolCallBlock('c7', 'bash')], t0 + 10, { seq: 11 }));
	s.emit('session/event', MAIN_SESSION, toolCall(7, 'c7', 'bash', t0 + 20, { seq: 12 }));
	s.emit('session/event', MAIN_SESSION, toolResult(7, 'c7', t0 + 30));
	s.emit('session/event', MAIN_SESSION, assistantText(7, '工具完成后的最终回答', t0 + 40, { seq: 13 }));
	s.emit('session/event', MAIN_SESSION, turnEnd(7, 'completed', Date.now(), 14));
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1, 'C1-7 one log', s.logLines());
	check(s.bells().length === 1, 'C1-7 one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-7: 多 assistant/message 只最终 text 通知一次 ✓');
}

// C1-8: duplicate turn/end → 只通知一次
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 8, { startAgoMs: 30_000 });
	s.emit('session/event', MAIN_SESSION, turnEnd(8, 'completed', Date.now() + 100));
	s.emit('session/event', MAIN_SESSION, turnEnd(8, 'completed', Date.now() + 200));
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1, 'C1-8 one log', s.logLines());
	check(s.bells().length === 1, 'C1-8 one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-8: duplicate turn/end 只通知一次 ✓');
}

// C1-9: reason != completed（即使有 final text）→ 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(9, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(9, '任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(9, '最终回答', t0 + 10));
	s.emit('session/event', MAIN_SESSION, turnEnd(9, 'error', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-9 non-completed silent despite final text', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-9: reason != completed 不通知 ✓');
}

// C1-10: 子 agent 即使有 final text → 不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', SUB_SESSION, turnStart(10, t0));
	s.emit('session/event', SUB_SESSION, turnUserMsg(10, '子任务', t0 + 5));
	s.emit('session/event', SUB_SESSION, assistantText(10, '子代理最终回答', t0 + 10));
	s.emit('session/event', SUB_SESSION, turnEnd(10, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-10 subagent with final text silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-10: 子 agent 不通知 ✓');
}

// C1-11: short duration + final text → 日志、不响
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 11, { startAgoMs: 2_000 });
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1 && s.logLines()[0].includes('✓ completed (2s)'), 'C1-11 log kept', s.logLines());
	check(s.bells().length === 0, 'C1-11 no BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-11: 短请求只日志 ✓');
}

// C1-12: long duration + final text → done
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	completeTurn(s, 12, { startAgoMs: 60_000 });
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1 && s.logLines()[0].includes('✓ completed (60s)'), 'C1-12 log', s.logLines());
	check(s.bells().length === 1, 'C1-12 one BEL', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-12: 长请求 done ✓');
}

// C1-13: 缺 turn/start + 有最终 assistant text → 安全日志，不虚构 duration
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	s.emit('session/event', MAIN_SESSION, assistantText(77, '插件中途加载后的最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(77, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.logLines().length === 1 && s.logLines()[0] === '[notify-bell] ✓ completed: turn #77', 'C1-13 unknown duration log', s.logLines());
	check(s.bells().length === 0, 'C1-13 no BEL without start', s.bells());
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-13: 缺 turn/start 只安全日志 ✓');
}

// C1-14: assistant/message 同时含 text + tool-call → 不是最终文本回答
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(14, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(14, '混合回答', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantMessage(14, [textBlock('带工具调用的文本'), toolCallBlock('c14', 'finish_tool')], t0 + 10));
	s.emit('session/event', MAIN_SESSION, toolCall(14, 'c14', 'finish_tool', t0 + 20));
	s.emit('session/event', MAIN_SESSION, toolResult(14, 'c14', t0 + 30));
	s.emit('session/event', MAIN_SESSION, turnEnd(14, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-14 mixed text+toolcall silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-14: 混合 text+tool-call 不通知 ✓');
}

// C1-15: 非 completed 结束后完整重放同 turn（start + final text + completed）→ 仍只按首次 end 处理，不通知
{
	const s = setup({ bell: { gapMs: GAP, permissionGapMs: GAP } });
	s.applyPlugin();
	const t0 = Date.now() - 30_000;
	s.emit('session/event', MAIN_SESSION, turnStart(15, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(15, '原任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(15, '原回答', t0 + 10));
	s.emit('session/event', MAIN_SESSION, turnEnd(15, 'error', t0 + 1_000));
	// 完整重放同 turn，并补齐 final text + completed
	s.emit('session/event', MAIN_SESSION, turnStart(15, t0));
	s.emit('session/event', MAIN_SESSION, turnUserMsg(15, '原任务', t0 + 5));
	s.emit('session/event', MAIN_SESSION, assistantText(15, '重放后的最终回答', Date.now() - 1_000));
	s.emit('session/event', MAIN_SESSION, turnEnd(15, 'completed', Date.now()));
	await sleep(GAP * 2 + 20);
	check(s.writes.length === 0, 'C1-15 full replay after non-completed silent', s.writes);
	rmSync(s.dir, { recursive: true, force: true });
	report('C1-15: 非 completed 后完整重放不通知 ✓');
}

if (!failed) report('ALL TESTS PASSED');
else process.exitCode = 1;




