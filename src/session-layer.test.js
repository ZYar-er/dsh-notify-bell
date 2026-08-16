/**
 * dsh-notify-bell — 会话层集成测试（真实 Cordis Context + DSH SessionStore）。
 *
 * 与 src/test.js 的 mock ctx 不同，这里的事件来自 @deepseek-ai/dsh-session
 * 的真实 Session.append()：事件 seq/time 由 Session 生成，随后通过 Cordis
 * 的 session/event 派发到插件。测试关注“用户输入 → 检查插件反应”。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply } from './index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 启动一个真实 Cordis root：SessionStore + notify-bell，并捕获插件 stdout/BEL。 */
function boot(options = {}) {
const dir = mkdtempSync(join(tmpdir(), 'notify-bell-session-layer-'));
const file = join(dir, 'config.json');
writeFileSync(file, JSON.stringify({
enabled: true,
// 会话层测试事件在毫秒级完成；把门槛降到 1ms，避免测试依赖真实耗时。
minDuration: options.minDuration ?? 0.001,
bell: { gapMs: 1, permissionGapMs: 1 }
}));
const writes = [];
const root = new Context();
const plugin = {
name: 'notify-bell-session-layer',
inject: [],
apply(ctx, config) {
apply(ctx, config, {
configPath: file,
write: (chunk) => writes.push(String(chunk)),
isTTY: () => true,
warn: () => {}
});
}
};
return {
dir,
file,
writes,
root,
async start() {
await root.plugin(SessionStore);
await root.plugin(plugin);
return root.sessions;
},
async stop() {
await root.fiber.dispose();
rmSync(dir, { recursive: true, force: true });
}
};
}

/** DSH 真实 user/message：turn/start 之后 append 的 message 本体（事件本身无 turn 字段）。 */
function appendUserMessage(session, text, id = 'm-user') {
return session.append('user/message', {
id,
role: 'user',
source: { kind: 'user' },
content: [{ type: 'text', text }]
}, { surfaceOp: 'append' });
}

/** DSH 真实 goal-round user/message（自动续跑轮次没有 human source）。 */
function appendGoalMessage(session, text, id = 'm-goal') {
return session.append('user/message', {
id,
role: 'user',
source: { kind: 'goal', goalId: 'goal-session-layer', revision: 1, round: 1 },
content: [{ type: 'text', text }]
}, { surfaceOp: 'append' });
}

/** 真实 DSH 最终回答：assistant/chunk → assistant/message（sourceEventSeqs 引用 chunk）。 */
function appendFinalAssistantText(session, turn, text, step = 1) {
const chunk = session.append('assistant/chunk', {
turn,
step,
chunk: { type: 'text', text }
});
return session.append('assistant/message', {
turn,
step,
message: {
id: `a-${turn}-${step}`,
role: 'assistant',
source: { kind: 'model', provider: 'mock', model: 'mock' },
content: [{ type: 'text', text }]
}
}, {
surfaceOp: 'append',
sourceEventSeqs: [chunk.seq]
});
}

/** tool-call-only assistant message + 真实 tool/call + tool/result。 */
function appendToolOnlyStep(session, turn, callId = 'call-finish', step = 1) {
session.append('assistant/message', {
turn,
step,
message: {
id: `a-tool-${turn}-${step}`,
role: 'assistant',
source: { kind: 'model', provider: 'mock', model: 'mock' },
content: [{ type: 'tool-call', id: callId, name: 'finish_tool', arguments: '{}' }]
}
}, { surfaceOp: 'append', sourceEventSeqs: [] });
const call = session.append('tool/call', {
turn,
step,
callId,
name: 'finish_tool',
arguments: '{}'
});
session.append('tool/result', {
turn,
step,
message: {
id: `r-${callId}`,
role: 'user',
source: { kind: 'tool', callId },
content: [{
type: 'tool-result',
toolCallId: callId,
content: [{ type: 'text', text: 'ok' }]
}]
}
}, {
surfaceOp: 'append',
sourceEventSeqs: [call.seq]
});
}

test('会话层：真实用户输入 + final assistant text → ✓ completed 日志 + done BEL', async () => {
const harness = boot();
try {
const sessions = await harness.start();
const session = sessions.create('session-main-user', { meta: {} });
session.append('turn/start', { turn: 1 });
appendUserMessage(session, '请修复进度条卡顿');
appendFinalAssistantText(session, 1, '已修复，最终回答');
await sleep(5);
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

const logs = harness.writes.filter((chunk) => chunk.startsWith('[notify-bell]'));
const bels = harness.writes.filter((chunk) => chunk === '\x07');
assert.equal(logs.length, 1, JSON.stringify(harness.writes));
assert.match(logs[0], /✓ completed/);
assert.match(logs[0], /请修复进度条卡顿/);
assert.equal(bels.length, 1, JSON.stringify(harness.writes));
} finally {
await harness.stop();
}
});

test('会话层：无用户输入的 no-op completed turn → 完全静默', async () => {
const harness = boot();
try {
const sessions = await harness.start();
const session = sessions.create('session-main-noop', { meta: {} });
session.append('turn/start', { turn: 1 });
await sleep(5);
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
assert.equal(harness.writes.length, 0, JSON.stringify(harness.writes));
} finally {
await harness.stop();
}
});

test('会话层：用户输入后 tool-call-only concludesTurn → 不输出 completed', async () => {
const harness = boot();
try {
const sessions = await harness.start();
const session = sessions.create('session-main-tool-only', { meta: {} });
session.append('turn/start', { turn: 1 });
appendUserMessage(session, '执行收尾工具');
appendToolOnlyStep(session, 1);
await sleep(5);
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
assert.equal(harness.writes.length, 0, JSON.stringify(harness.writes));
} finally {
await harness.stop();
}
});

test('会话层：goal 自动轮次（无 human user/message）但有 final text → 仍通知', async () => {
const harness = boot();
try {
const sessions = await harness.start();
const session = sessions.create('session-main-goal', { meta: {} });
session.append('turn/start', { turn: 1 });
appendGoalMessage(session, '继续完成目标');
appendFinalAssistantText(session, 1, '目标已完成');
await sleep(5);
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

const logs = harness.writes.filter((chunk) => chunk.startsWith('[notify-bell]'));
const bels = harness.writes.filter((chunk) => chunk === '\x07');
assert.equal(logs.length, 1, JSON.stringify(harness.writes));
assert.match(logs[0], /✓ completed/);
assert.equal(bels.length, 1, JSON.stringify(harness.writes));
} finally {
await harness.stop();
}
});

test('会话层：子代理 session 即使有真实用户输入和 final text → 不通知', async () => {
const harness = boot();
try {
const sessions = await harness.start();
const session = sessions.create('session-sub', { meta: { delegationDepth: 1 } });
session.append('turn/start', { turn: 1 });
appendUserMessage(session, '子代理任务');
appendFinalAssistantText(session, 1, '子代理最终回答');
await sleep(5);
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
assert.equal(harness.writes.length, 0, JSON.stringify(harness.writes));
} finally {
await harness.stop();
}
});
