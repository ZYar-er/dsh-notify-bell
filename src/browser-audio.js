/**
 * dsh-notify-bell — 浏览器播放器核心（playback: "browser" 实验）。
 *
 * 职责：消费后端经 SSE 推送的 semantic sound 帧，用 Web Audio 播放。
 * 本模块不分类任何事件——后端是唯一事件事实源，这里只做：
 *   1. 解析 SSE 帧（event 名 + JSON data）。
 *   2. 维护 AudioContext + 声音 buffer 缓存（懒加载）。
 *   3. 用户交互（pointerdown/keydown）时 unlock（resume）AudioContext。
 *   4. 记录可诊断状态（locked / lastError / plays）。
 *
 * 依赖全部可注入（AudioContext 构造、fetch、unlock 监听注册），
 * 因此可以在 node 单测中注入 fake 完整覆盖；client.js 内联了与本
 * 文件同一契约的实现（打包 bundle 无法 import 本模块），两者必须
 * 保持行为一致——以本文件为参考实现。
 *
 * autoplay 策略：浏览器在用户手势前禁止有声播放。AudioContext 在
 * 手势中创建/resume 后即 running；未解锁时 playSound 静默失败并
 * 记录 locked 状态（不抛异常、不 fallback 到后端——本阶段必须明确
 * 浏览器自己能否播放）。
 */

/** semantic sound → 静态 WAV URL（后端 /notify-bell/sounds 提供）。
 *  包含 'default'（与后端 BEL/WAV 一致：default → done）。 */
export const SOUND_URLS = Object.freeze({
	done: '/notify-bell/sounds/done.wav',
	permission: '/notify-bell/sounds/permission.wav',
	question: '/notify-bell/sounds/question.wav',
	block: '/notify-bell/sounds/block.wav',
	error: '/notify-bell/sounds/error.wav',
	default: '/notify-bell/sounds/done.wav'
});

/** 浏览器 unlock 监听的事件类型（保持最小集合，unlock 成功后移除）。 */
const UNLOCK_EVENT_TYPES = ['pointerdown', 'keydown'];

/**
 * 创建浏览器音频播放器。
 * @param options - 注入（测试用）：
 *   - AudioContextCtor: AudioContext 构造器（默认 window.AudioContext）。
 *   - fetchImpl: fetch 实现（默认全局 fetch）。
 *   - attachUnlockListeners: (handler) => disposer，注册解锁监听。
 */
export function createBrowserAudio(options = {}) {
	const AudioContextCtor = options.AudioContextCtor ?? (
		typeof window !== 'undefined' ? (window.AudioContext ?? window.webkitAudioContext) : undefined
	);
	const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);

	let ctx = null;
	const buffers = new Map();
	let unlockDisposer = null;
	const state = {
		/** 尚未通过用户手势解锁（AudioContext 被 autoplay 策略挂起）。 */
		locked: true,
		/** 已收到后端 ready 帧。 */
		ready: false,
		/** ready 帧携带的后端 enabled 状态。 */
		enabled: true,
		/** 最近一次失败原因（可诊断；'' = 无）。 */
		lastError: '',
		/** 成功启动的播放次数。 */
		plays: 0
	};

	/** 懒创建 AudioContext（在用户手势内创建时通常直接 running）。 */
	const ensureCtx = () => {
		if (ctx !== null) return ctx;
		if (!AudioContextCtor) {
			state.lastError = 'AudioContext unavailable';
			return null;
		}
		try {
			ctx = new AudioContextCtor();
		} catch (error) {
			ctx = null;
			state.lastError = `AudioContext creation failed: ${error instanceof Error ? error.message : String(error)}`;
			return null;
		}
		return ctx;
	};

	/** 尝试解锁：resume 挂起的 AudioContext；成功后移除 unlock 监听。 */
	const unlock = async () => {
		const audio = ensureCtx();
		if (audio === null) return false;
		try {
			if (audio.state === 'suspended') await audio.resume();
		} catch (error) {
			state.lastError = `resume failed: ${error instanceof Error ? error.message : String(error)}`;
			return false;
		}
		const ok = audio.state === 'running';
		if (ok) {
			state.locked = false;
			state.lastError = '';
			removeUnlockListeners();
		}
		return ok;
	};

	/** 加载并缓存一个声音 buffer（只 decode 一次）。 */
	const loadBuffer = async (audio, url) => {
		const cached = buffers.get(url);
		if (cached !== undefined) return cached;
		if (!fetchImpl) throw new Error('fetch unavailable');
		const response = await fetchImpl(url);
		if (!response.ok) throw new Error(`fetch ${url} -> ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		const buffer = await audio.decodeAudioData(arrayBuffer);
		buffers.set(url, buffer);
		return buffer;
	};

	/**
	 * 播放一个 semantic sound。未解锁/加载失败均静默返回 false，
	 * 记录 state.lastError，不抛异常（不影响 DSH 页面）。
	 */
	const playSound = async (sound) => {
		const url = SOUND_URLS[sound];
		if (typeof sound !== 'string' || url === undefined) {
			state.lastError = `unknown sound: ${String(sound)}`;
			return false;
		}
		const audio = ensureCtx();
		if (audio === null) return false;
		if (audio.state !== 'running') {
			state.locked = true;
			state.lastError = `autoplay locked (ctx ${audio.state}); unlock with a user gesture`;
			return false;
		}
		try {
			const buffer = await loadBuffer(audio, url);
			const source = audio.createBufferSource();
			source.buffer = buffer;
			source.connect(audio.destination);
			source.start();
			state.plays += 1;
			state.locked = false;
			state.lastError = '';
			return true;
		} catch (error) {
			state.lastError = `play failed: ${error instanceof Error ? error.message : String(error)}`;
			return false;
		}
	};

	/**
	 * 处理一帧 SSE（EventSource 按 event 名分派后调用）。
	 * @param event - 'ready' | 'notify'。
	 * @param data - 解析后的 JSON 载荷。
	 */
	const handleFrame = (event, data) => {
		if (event === 'ready') {
			state.ready = true;
			if (typeof data?.enabled === 'boolean') state.enabled = data.enabled;
			return;
		}
		if (event === 'notify') {
			// enabled=false 时后端本就不推；这里再兜底一次（ready 快照可能过期）。
			if (!state.enabled) return;
			void playSound(data?.sound);
			return;
		}
		state.lastError = `unknown sse event: ${String(event)}`;
	};

	const removeUnlockListeners = () => {
		if (unlockDisposer !== null) {
			const dispose = unlockDisposer;
			unlockDisposer = null;
			dispose();
		}
	};

	/** 注册解锁监听（幂等；unlock 成功后自动移除）。 */
	const attachUnlockListeners = () => {
		if (unlockDisposer !== null) return;
		const handler = () => {
			void unlock();
		};
		if (typeof options.attachUnlockListeners === 'function') {
			unlockDisposer = options.attachUnlockListeners(handler);
			return;
		}
		if (typeof window === 'undefined') return;
		for (const type of UNLOCK_EVENT_TYPES) window.addEventListener(type, handler, true);
		unlockDisposer = () => {
			for (const type of UNLOCK_EVENT_TYPES) window.removeEventListener(type, handler, true);
		};
	};

	const dispose = () => {
		removeUnlockListeners();
		buffers.clear();
		if (ctx !== null) {
			try {
				void ctx.close();
			} catch {
				// 忽略关闭失败。
			}
			ctx = null;
		}
	};

	return {
		unlock,
		playSound,
		handleFrame,
		attachUnlockListeners,
		/** 状态快照（诊断/测试用）。 */
		getState: () => ({ ...state }),
		dispose
	};
}
