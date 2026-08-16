/**
 * dsh-notify-bell — 任务完成/受阻/审批/提问/出错通知插件（语义化 sound）。
 *
 * 官方 Cordis 插件形态（见 DSH 文档 develop/basic）：
 *   - 导出 `name`、`inject`（无服务依赖）、`Config`（Schemastery schema，
 *     Cordis 用它校验 cordis.yml 的 config 并填充默认值）。
 *   - `apply(ctx, config)`：config 来自 Cordis 配置层；legacy 文件
 *     （~/.config/dsh/notify-bell.json）作为低优先级层合并（见 config.js）。
 *   - 通过 ctx 注册的监听/inject 在插件卸载时自动清理。
 *
 * 结构（便于以后扩展 wav/webhook 等后端）：
 *   - config.js  配置 schema/合并（sound 解析/校验、旧 bellCount 兼容、soundPack）
 *   - events.js  事件分类（输出事件类型 + 默认语义 sound，不含响铃细节）
 *   - bell.js    BEL 后端（play(sound)，内部维护 sound → count/gap 映射）
 *   - wav.js     WAV 后端（Windows/WSL/Linux，失败 fallback BEL）
 *   - log.js     日志后端（stdout 输出 + maxLength 截断）
 *
 * 事件语义（受配置 events.* 控制）：
 *   - complete：duration >= minDuration 时播放 events.complete.sound
 *     （默认 done）；耗时不足只输出日志。duration = now - goal.createdAt。
 *   - block：不受 minDuration 限制，播放 events.block.sound（默认 block）。
 *   - approval：session/event 的 approval/asked（权限问题被提出）时播放
 *     events.approval.sound（默认 permission），不受 minDuration 限制；
 *     approval/decided 不触发通知。
 *   - question：session/event 的 tool/call + ask_user_question 时播放
 *     events.question.sound（默认 question），不受 minDuration 限制；
 *     普通文本问号不触发。
 *   - error：agent/error（step/turn 出错）播放 events.error.sound（默认 error）。
 *   - 其余操作（create/edit/pause/resume/clear 等）不产生任何输出。
 *
 * 行为：
 *   - enabled=false 时全部通知关闭（不影响 DSH 自身）。
 *   - 防重复：同一 change.ref（goal id@revision）、同一 error
 *     （agent id@turn@step）、同一 approval（session id@approval id）、
 *     同一 question（session id@callId）只通知一次。
 *   - objective/错误消息按 objective.maxLength（默认 120）截断。
 *   - BEL 只在 process.stdout.isTTY 时写入；日志行始终输出。
 *   - soundPack 目前支持 "default"（BEL）与 "wav"（本地音频）。
 *
 * @param ctx - Cordis 上下文。
 * @param config - Cordis 配置（schema 校验 + 默认填充）。
 * @param options - 可选注入（测试用）：configPath（配置文件路径）、
 *   warn（warning 输出）、write（stdout 写入）、isTTY（TTY 判断）。
 */
import { loadConfig, writeEnabled, mergeConfig } from './config.js';
import { createBellBackend } from './bell.js';
import { createWavBackend } from './wav.js';
import { createLogBackend } from './log.js';
import { classifyGoalChange, classifyApproval, classifyQuestion, classifyAgentError } from './events.js';

export { Config } from './config.js';

export const name = 'notify-bell';

/** 本插件只消费事件，不依赖任何服务。 */
export const inject = [];

export function apply(ctx, config = {}, options = {}) {
	const { config: fileConfig, path } = loadConfig({
		configPath: options.configPath,
		warn: options.warn ?? ((message) => process.stderr.write(message + '\n'))
	});
	// 合并层：Cordis 显式字段 > legacy 文件 > schema 默认（见 config.js）。
	config = mergeConfig(config, fileConfig);
	const persistEnabled = options.writeEnabled ?? writeEnabled;
	/** 运行时 enabled 状态（Web 开关可立即改变，无需重启）。 */
	let enabled = config.enabled;
	const backendOptions = {
		gapMs: config.bell.gapMs,
		permissionGapMs: config.bell.permissionGapMs,
		write: options.write,
		isTTY: options.isTTY
	};
	// soundPack 选择 backend：'default' → BEL；'wav' → 本地音频（失败回退 BEL）。
	const backend = config.soundPack === 'wav'
		? createWavBackend({
			...backendOptions,
			directory: config.wav.directory,
			fallback: config.wav.fallback,
			spawn: options.spawn,
			spawnSync: options.spawnSync,
			existsSync: options.existsSync,
			player: options.player
		})
		: createBellBackend(backendOptions);
	const log = createLogBackend({
		maxLength: config.objective.maxLength,
		write: options.write
	});
	const notified = new Set();

	/** 运行时开关：先持久化（失败抛错、状态不变），成功后才更新运行时状态。 */
	const setEnabled = (next) => {
		persistEnabled(path, next);
		enabled = next;
	};

	/** 去重 + enabled 门控；返回是否允许本次通知。 */
	const admit = (classified) => {
		if (!enabled) return false;
		const evt = config.events[classified.kind];
		if (!evt?.enabled) return false;
		if (notified.has(classified.dedupeKey)) return false;
		notified.add(classified.dedupeKey);
		return true;
	};

	// Web → backend 开关 HTTP API（由 dsh-notify-bell 自己暴露，不修改 DSH 核心）。
	// GET  /notify-bell                 → { ok, value: { enabled } }
	// POST /notify-bell/setEnabled      → body { enabled } → 持久化 + 运行时生效
	// POST /notify-bell/toggle          → 翻转 enabled
	// 任何失败（含配置写失败）返回 { ok: false, error }，客户端据此回滚。
	ctx.inject(['webServer'], (webCtx) => {
		const readBody = async (req) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			return Buffer.concat(chunks).toString('utf8');
		};
		const json = (res, status, body) => {
			const text = JSON.stringify(body);
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(text);
		};
		webCtx.webServer.register({
			kind: 'prefix',
			path: '/notify-bell',
			handler: async (req, res) => {
				const url = new URL(req.url ?? '/', 'http://notify-bell');
				const endpoint = url.pathname.replace(/^\/notify-bell\/?/, '') || 'getEnabled';
				try {
					if (endpoint === 'getEnabled') {
						return json(res, 200, { ok: true, value: { enabled } });
					}
					if (req.method !== 'POST') {
						return json(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } });
					}
					let args = {};
					try {
						args = JSON.parse(await readBody(req) || '{}');
					} catch {
						return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'body must be JSON' } });
					}
					if (endpoint === 'setEnabled') {
						if (typeof args.enabled !== 'boolean') return json(res, 400, { ok: false, error: { code: 'bad-request', message: 'enabled must be a boolean' } });
						setEnabled(args.enabled);
						return json(res, 200, { ok: true, value: { enabled } });
					}
					if (endpoint === 'toggle') {
						setEnabled(!enabled);
						return json(res, 200, { ok: true, value: { enabled } });
					}
					return json(res, 404, { ok: false, error: { code: 'not-found', message: `unknown endpoint ${endpoint}` } });
				} catch (error) {
					return json(res, 500, { ok: false, error: { code: 'write-failed', message: error instanceof Error ? error.message : String(error) } });
				}
			}
		});
	});

	ctx.on('goal/changed', ({ change }) => {
		const classified = classifyGoalChange(change);
		if (!classified || !admit(classified)) return;

		const objective = log.truncate(classified.objective ?? '(goal view unavailable)');
		const createdAt = classified.createdAt;
		const durationS = createdAt === null ? null : Math.max(0, Math.round((Date.now() - createdAt) / 1000));
		const durationText = durationS === null ? '' : ` (${durationS}s)`;

		if (classified.kind === 'complete') {
			log.line(`[notify-bell] ✓ completed${durationText}: ${objective}`);
			const durationMs = createdAt === null ? Infinity : Date.now() - createdAt;
			if (durationMs >= config.minDuration * 1000) backend.play(config.events.complete.sound);
			return;
		}
		// block：不受 minDuration 限制。
		log.line(`[notify-bell] ⚠ blocked${durationText}: ${objective}`);
		backend.play(config.events.block.sound);
	});

	ctx.on('session/event', (session, event) => {
		const classified = classifyApproval(session, event) ?? classifyQuestion(session, event);
		if (!classified || !admit(classified)) return;

		if (classified.kind === 'question') {
			// Agent 主动提问（tool/call + ask_user_question）：不受 minDuration 限制。
			const text = log.truncate(classified.questionText ?? '(question)');
			const optionsText = classified.optionsCount > 0 ? ` (${classified.optionsCount} options)` : '';
			log.line(`[notify-bell] ❓ question: ${text}${optionsText}`);
			backend.play(config.events.question.sound);
			return;
		}
		// approval：reason 缺失时只输出 toolName，不输出 undefined/null。
		const reasonText = classified.reason === null ? '' : `: ${classified.reason}`;
		log.line(`[notify-bell] 🔐 approval: ${classified.toolName}${reasonText}`);
		backend.play(config.events.approval.sound);
	});

	ctx.on('agent/error', (payload) => {
		const classified = classifyAgentError(payload);
		if (!classified || !admit(classified)) return;

		const where = classified.turn === null
			? ''
			: ` (turn ${classified.turn}${classified.step === null ? '' : ` step ${classified.step}`})`;
		log.line(`[notify-bell] ✗ error${where}: ${log.truncate(classified.message)}`);
		backend.play(config.events.error.sound);
	});
}
