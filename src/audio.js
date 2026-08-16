/**
 * dsh-notify-bell — 平台感知音频后端（v7）。
 *
 * 同一套 WAV sound pack 同时支持：
 *   - WSL        → powershell.exe + System.Media.SoundPlayer（Windows 侧音频）
 *   - Windows    → 同上（Windows 原生，不调用 wsl.exe / wslpath）
 *   - Linux      → 探测 paplay / pw-play / aplay / ffplay（只使用系统已有播放器）
 *   - 其他平台   → 直接 fallback BEL
 *
 * 事件层完全不感知平台：统一接口 { play(sound), dispose() }。
 *
 * 可靠性（最重要）：
 *   - 音频文件缺失 → 自动 fallback 到 BEL backend
 *   - 播放器不可用 / spawn 失败 / 非零退出 / 路径转换失败 → fallback 到 BEL
 *   - 任何情况下都不抛异常、不影响 DSH 与插件存活
 *   - 播放进程异步 spawn，不阻塞 DSH 事件循环
 *
 * TTY 语义：WAV 播放走系统音频，与终端无关——非 TTY 时照常播放；
 * 只有 fallback 到 BEL 时才受 isTTY 守卫（bell backend 自带）。
 *
 * 零第三方依赖（node:fs / node:path / node:child_process）。
 */
import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from 'node:fs';
import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createBellBackend } from './bell.js';

/** 语义 sound → 本地文件名（音频后端内部映射，事件层不可见）。 */
export const SOUND_FILES = Object.freeze({
	done: 'done.wav',
	permission: 'permission.wav',
	block: 'block.wav',
	question: 'question.wav',
	error: 'error.wav',
	default: 'done.wav'
});

/** 平台分类：'windows' | 'wsl' | 'linux' | 'other'。 */
export function detectPlatform(env = process.env, platform = process.platform, readFile = defaultReadFileSync) {
	if (platform === 'win32') return 'windows';
	if (platform === 'linux') {
		// WSL 标志：环境变量（WSL_INTEROP / WSL_DISTRO_NAME）或 /proc/version 含 microsoft。
		if (typeof env.WSL_INTEROP === 'string' && env.WSL_INTEROP.length > 0) return 'wsl';
		if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME.length > 0) return 'wsl';
		try {
			if (/microsoft/i.test(readFile('/proc/version', 'utf8'))) return 'wsl';
		} catch {
			// /proc/version 不可读 → 视为普通 Linux
		}
		return 'linux';
	}
	return 'other';
}

/** SoundPlayer 播放脚本（winPath 为 Windows 路径；PlaySync 阻塞直到播完）。 */
function soundPlayerScript(winPath) {
	return `$p = New-Object System.Media.SoundPlayer '${winPath}'; $p.PlaySync()`;
}

/** 探测一个可执行文件是否可用（spawnSync status === 0）。 */
function probeCommand(spawnSyncImpl, cmd, args) {
	try {
		return spawnSyncImpl(cmd, args, { stdio: 'ignore' })?.status === 0;
	} catch {
		return false;
	}
}

/** Windows/WSL 播放器：powershell.exe + System.Media.SoundPlayer。 */
export function detectWindowsPlayer(spawnSyncImpl = defaultSpawnSync) {
	const candidates = [
		'powershell.exe',
		'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		'pwsh'
	];
	for (const cmd of candidates) {
		if (probeCommand(spawnSyncImpl, cmd, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])) {
			return {
				cmd,
				buildArgs: (target) => ['-NoProfile', '-NonInteractive', '-Command', soundPlayerScript(target)]
			};
		}
	}
	return null;
}

/** Linux 播放器探测优先级：paplay (PulseAudio) → pw-play (PipeWire) → aplay (ALSA) → ffplay (通用)。 */
export function detectLinuxPlayer(spawnSyncImpl = defaultSpawnSync) {
	const candidates = [
		{ cmd: 'paplay', probe: ['--version'], buildArgs: (target) => [target] },
		{ cmd: 'pw-play', probe: ['--version'], buildArgs: (target) => [target] },
		{ cmd: 'aplay', probe: ['--version'], buildArgs: (target) => ['-q', target] },
		{ cmd: 'ffplay', probe: ['-version'], buildArgs: (target) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', target] }
	];
	for (const candidate of candidates) {
		if (probeCommand(spawnSyncImpl, candidate.cmd, candidate.probe)) {
			return { cmd: candidate.cmd, buildArgs: candidate.buildArgs };
		}
	}
	return null;
}

/** 按平台探测播放器；'other' 平台返回 null（直接 fallback BEL）。 */
export function detectPlayerFor(platform, spawnSyncImpl = defaultSpawnSync) {
	if (platform === 'windows' || platform === 'wsl') return detectWindowsPlayer(spawnSyncImpl);
	if (platform === 'linux') return detectLinuxPlayer(spawnSyncImpl);
	return null;
}

/** 规范化播放器描述：缺失 buildArgs 时按 Windows SoundPlayer 处理（兼容简单注入）。 */
function normalizePlayer(player, platform, spawnSyncImpl) {
	if (player === undefined) return detectPlayerFor(platform, spawnSyncImpl);
	if (player === null) return null;
	return {
		cmd: player.cmd,
		buildArgs: typeof player.buildArgs === 'function' ? player.buildArgs : soundPlayerScriptBuilder()
	};
}

function soundPlayerScriptBuilder() {
	return (target) => ['-NoProfile', '-NonInteractive', '-Command', soundPlayerScript(target)];
}

/**
 * 创建平台感知音频后端。
 * @param options.platform - 平台（缺省自动检测；测试注入）。
 * @param options.directory - 音频目录（已展开 ~，跨平台路径）。
 * @param options.player - 播放器（缺省按平台探测；null 强制不可用）。
 * @param options.bell - 注入的 BEL backend（缺省自建）。
 * @param options.spawn / options.spawnSync / options.existsSync / options.env / options.readFile - 注入实现。
 * @returns { play(sound), dispose() }
 */
export function createAudioBackend(options = {}) {
	const platform = options.platform ?? detectPlatform(options.env, process.platform, options.readFile);
	const directory = options.directory;
	const bell = options.bell ?? createBellBackend({
		gapMs: options.gapMs,
		permissionGapMs: options.permissionGapMs,
		write: options.write,
		isTTY: options.isTTY
	});
	const spawnImpl = options.spawn ?? defaultSpawn;
	const spawnSyncImpl = options.spawnSync ?? defaultSpawnSync;
	const exists = options.existsSync ?? defaultExistsSync;
	const player = normalizePlayer(options.player, platform, spawnSyncImpl);
	const children = new Set();
	let disposed = false;

	/** WSL 平台需要把 WSL 路径转换为 Windows 路径（wslpath -w）。 */
	const needsPathConversion = platform === 'wsl';

	/** 播放一次 sound；失败自动 fallback 到 BEL（只 fallback 一次）。 */
	const play = (sound) => {
		if (disposed) return;
		const file = join(directory, SOUND_FILES[sound] ?? SOUND_FILES.default);
		let fellBack = false;
		const fallback = () => {
			if (disposed || fellBack) return;
			fellBack = true;
			bell.play(sound);
		};
		if (!exists(file)) {
			fallback();
			return;
		}
		if (!player) {
			fallback();
			return;
		}
		let target = file;
		if (needsPathConversion) {
			let winPath;
			try {
				const converted = spawnSyncImpl('wslpath', ['-w', file]);
				winPath = converted?.stdout?.toString().trim();
			} catch {
				fallback();
				return;
			}
			if (!winPath) {
				fallback();
				return;
			}
			target = winPath;
		}
		const args = player.buildArgs(target);
		try {
			const child = spawnImpl(player.cmd, args, { stdio: 'ignore', windowsHide: true });
			if (!child || typeof child.on !== 'function') {
				fallback();
				return;
			}
			children.add(child);
			const forget = () => children.delete(child);
			try {
				child.on('error', () => {
					forget();
					fallback();
				});
				child.on('exit', (code) => {
					forget();
					if (code !== 0) fallback();
				});
			} catch (error) {
				forget();
				throw error;
			}
		} catch {
			fallback();
		}
	};

	/** 停止未决播放进程并释放 fallback BEL 的未决定时器。 */
	const dispose = () => {
		disposed = true;
		for (const child of children) {
			try {
				child?.kill?.();
			} catch {
				// kill 失败不阻断卸载
			}
		}
		children.clear();
		bell.dispose?.();
	};

	return { play, dispose };
}
