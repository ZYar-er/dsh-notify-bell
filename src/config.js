/**
 * dsh-notify-bell — 配置加载模块（v6：WAV soundPack + 语义化 sound）。
 *
 * 配置来源：`~/.config/dsh/notify-bell.json`（可用环境变量
 * `DSH_NOTIFY_BELL_CONFIG` 覆盖路径）。文件不存在时使用内置默认值；
 * JSON 非法时打印 warning 并回退默认值；字段级类型校验，非法字段
 * 静默回退默认值。零第三方依赖（node:fs / node:os / node:path）。
 *
 * 事件层只暴露语义化 sound（done / block / permission / error / default）；
 * "响几声/什么节奏/播什么文件"由 backend 内部决定（bell.js / wav.js）。
 * soundPack 选择 backend：'default' → BEL；'wav' → 本地 WAV 文件播放
 * （失败自动 fallback 到 BEL）。旧版 `bellCount` 配置仍然兼容：
 * 1 → done，2 → permission，3 → error，其他值回退该事件的默认 sound；
 * `sound` 优先于 `bellCount`。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 语义化 sound 词汇表（事件层唯一的声音语义）。 */
export const SEMANTIC_SOUNDS = Object.freeze(['done', 'block', 'permission', 'question', 'error', 'default']);

/** 每个事件类型的默认语义 sound。 */
export const DEFAULT_EVENT_SOUNDS = Object.freeze({
	complete: 'done',
	block: 'block',
	approval: 'permission',
	question: 'question',
	error: 'error'
});

/** 旧 bellCount 配置的兼容映射（仅 BEL backend 时代的历史语义）。 */
const BELL_COUNT_TO_SOUND = Object.freeze({
	1: 'done',
	2: 'permission',
	3: 'error'
});

/** 已实现的 soundPack：'default' → BEL backend；'wav' → 本地音频 backend。 */
export const VALID_SOUND_PACKS = Object.freeze(['default', 'wav']);

/** WAV backend 的 fallback 策略（当前仅支持回退到 BEL）。 */
const VALID_WAV_FALLBACKS = Object.freeze(['bell']);

/** 展开开头的 ~ 为用户主目录。 */
function expandTilde(path, home = homedir()) {
	return typeof path === 'string' && path.startsWith('~/') ? join(home, path.slice(2)) : path;
}

/** 内置默认配置（与 ~/.config/dsh/notify-bell.json 的推荐内容一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	minDuration: 10,
	objective: Object.freeze({ maxLength: 120 }),
	events: Object.freeze({
		complete: Object.freeze({ enabled: true, sound: 'done' }),
		block: Object.freeze({ enabled: true, sound: 'block' }),
		approval: Object.freeze({ enabled: true, sound: 'permission' }),
		question: Object.freeze({ enabled: true, sound: 'question' }),
		error: Object.freeze({ enabled: true, sound: 'error' })
	}),
	soundPack: 'default',
	wav: Object.freeze({
		directory: '~/.config/dsh/notify-bell/sounds',
		fallback: 'bell'
	}),
	bell: Object.freeze({ gapMs: 150, permissionGapMs: 300 })
});

/** 深拷贝默认配置（调用方可以安全修改返回值）。 */
export function cloneDefaults() {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/** 解析配置路径：环境变量覆盖优先，否则 <home>/.config/dsh/notify-bell.json。 */
export function defaultConfigPath(env = process.env, home = homedir()) {
	const override = env?.DSH_NOTIFY_BELL_CONFIG;
	return typeof override === 'string' && override.length > 0 ? override : join(home, '.config', 'dsh', 'notify-bell.json');
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isPositive = (value) => isFiniteNumber(value) && value > 0;
const isPositiveInt = (value) => isPositive(value) && Number.isInteger(value);
const isNonNegativeInt = (value) => isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 校验单个事件子配置（enabled + sound）。
 * sound 优先级：合法 sound > 旧 bellCount 兼容映射 > 事件默认 sound。
 */
function sanitizeEvent(rawEvent, fallback) {
	const raw = isPlainObject(rawEvent) ? rawEvent : {};
	let sound;
	if (typeof raw.sound === 'string' && SEMANTIC_SOUNDS.includes(raw.sound)) {
		sound = raw.sound;
	} else if (isNonNegativeInt(raw.bellCount)) {
		sound = BELL_COUNT_TO_SOUND[raw.bellCount] ?? fallback.sound;
	} else {
		sound = fallback.sound;
	}
	return {
		enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
		sound
	};
}

/**
 * 对解析后的原始 JSON 做字段级类型校验：合法字段生效，非法字段回退
 * 默认值。整个 raw 不是对象时整体回退默认。
 */
export function sanitizeConfig(raw) {
	const cfg = cloneDefaults();
	if (!isPlainObject(raw)) return cfg;
	if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled;
	if (isPositive(raw.minDuration)) cfg.minDuration = raw.minDuration;
	if (isPlainObject(raw.objective) && isPositiveInt(raw.objective.maxLength)) cfg.objective.maxLength = raw.objective.maxLength;
	if (isPlainObject(raw.events)) {
		cfg.events.complete = sanitizeEvent(raw.events.complete, cfg.events.complete);
		cfg.events.block = sanitizeEvent(raw.events.block, cfg.events.block);
		cfg.events.approval = sanitizeEvent(raw.events.approval, cfg.events.approval);
		cfg.events.question = sanitizeEvent(raw.events.question, cfg.events.question);
		cfg.events.error = sanitizeEvent(raw.events.error, cfg.events.error);
	}
	if (typeof raw.soundPack === 'string' && VALID_SOUND_PACKS.includes(raw.soundPack)) cfg.soundPack = raw.soundPack;
	if (isPlainObject(raw.wav)) {
		if (typeof raw.wav.directory === 'string' && raw.wav.directory.length > 0) cfg.wav.directory = expandTilde(raw.wav.directory);
		if (typeof raw.wav.fallback === 'string' && VALID_WAV_FALLBACKS.includes(raw.wav.fallback)) cfg.wav.fallback = raw.wav.fallback;
	}
	if (isPlainObject(raw.bell)) {
		if (isPositive(raw.bell.gapMs)) cfg.bell.gapMs = raw.bell.gapMs;
		if (isPositive(raw.bell.permissionGapMs)) cfg.bell.permissionGapMs = raw.bell.permissionGapMs;
	}
	// 统一展开 wav.directory 的 ~（无论来自默认值还是用户配置）。
	cfg.wav.directory = expandTilde(cfg.wav.directory);
	return cfg;
}

/**
 * 加载并校验配置。
 * @param options.configPath - 显式配置文件路径（测试注入；缺省走环境变量/默认路径）。
 * @param options.env - 环境变量快照（测试注入）。
 * @param options.home - 主目录（测试注入）。
 * @param options.readFile - 文件读取实现（测试注入）。
 * @param options.warn - warning 输出（缺省写 stderr）。
 * @returns { path, config, source: 'file' | 'default' }
 */
export function loadConfig(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const readFile = options.readFile ?? readFileSync;
	const warn = options.warn ?? ((message) => process.stderr.write(message + '\n'));
	const path = options.configPath ?? defaultConfigPath(env, home);
	let raw;
	try {
		raw = JSON.parse(readFile(path, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			warn(`[notify-bell] config ${path} is not valid JSON, falling back to defaults: ${error.message}`);
		}
		return { path, config: sanitizeConfig({}), source: 'default' };
	}
	return { path, config: sanitizeConfig(raw), source: 'file' };
}

/**
 * 原子更新配置文件的 `enabled` 字段（保留其他所有字段）。
 * - 文件不存在 → 以最小结构创建（{ enabled }）。
 * - 文件是非法 JSON → 抛错且不改动原文件（Web UI 据此回滚，不崩溃）。
 * - 写入方式：同目录临时文件 + rename（原子替换）。
 * @param configPath - 配置文件路径。
 * @param enabled - 新的 enabled 布尔值。
 * @throws 当原文件存在但 JSON 非法，或写入/替换失败时。
 */
export function writeEnabled(configPath, enabled) {
	let cfg = {};
	try {
		cfg = JSON.parse(readFileSync(configPath, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			throw new Error(`notify-bell config ${configPath} is not valid JSON: ${error.message}`);
		}
	}
	cfg.enabled = enabled;
	mkdirSync(dirname(configPath), { recursive: true });
	const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
	try {
		renameSync(tmp, configPath);
	} catch (error) {
		try {
			renameSync(tmp, configPath);
		} catch {
			throw error;
		}
	}
}
