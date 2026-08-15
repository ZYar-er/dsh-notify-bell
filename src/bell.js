/**
 * dsh-notify-bell — BEL 响铃后端（v5：per-sound 节奏）。
 *
 * 事件层只传语义化 sound（done / block / permission / error / default），
 * "每种 sound 响几声、什么间隔" 是本 backend 的内部实现细节
 * （SOUND_PATTERNS：count + gap），不暴露给事件层或配置层。
 *
 * 节奏：
 *   done       → 1 声，gapMs
 *   block      → 2 声，gapMs（默认 150ms）
 *   permission → 2 声，permissionGapMs（默认 300ms）——审批等用户介入的节奏
 *   error      → 3 声，gapMs
 *   default    → 1 声，gapMs
 *   未知 sound → 1 声，gapMs（安全回退）
 *
 * 未来可在此目录增加其他 backend（wav 播放、webhook 远程通知），
 * 它们实现相同的 `play(sound)` 接口，由 soundPack 配置选择。
 */
export function createBellBackend(options = {}) {
	const isTTY = options.isTTY ?? (() => Boolean(process.stdout.isTTY));
	const write = options.write ?? ((chunk) => process.stdout.write(chunk));
	const gapMs = options.gapMs ?? 150;
	const permissionGapMs = options.permissionGapMs ?? 300;

	/** 语义 sound → 响铃模式（BEL backend 内部映射，事件层不可见）。 */
	const SOUND_PATTERNS = Object.freeze({
		done: { count: 1, gap: gapMs },
		block: { count: 2, gap: gapMs },
		permission: { count: 2, gap: permissionGapMs },
		question: { count: 2, gap: gapMs },
		error: { count: 3, gap: gapMs },
		default: { count: 1, gap: gapMs }
	});

	const timers = new Set();

	/** 按 count/gap 响铃：第一声立即，后续每声间隔 gap（内部实现细节）。 */
	const ring = (count, gap) => {
		if (!isTTY()) return;
		const n = Math.max(0, Math.floor(count));
		for (let i = 0; i < n; i++) {
			if (i === 0) {
				write('\x07');
			} else {
				const timer = setTimeout(() => write('\x07'), gap * i);
				timer.unref?.();
				timers.add(timer);
			}
		}
	};

	/**
	 * 播放一个语义化 sound。
	 * @param sound - done | block | permission | error | default；未知 sound 安全回退。
	 */
	const play = (sound) => {
		const pattern = SOUND_PATTERNS[sound] ?? SOUND_PATTERNS.default;
		ring(pattern.count, pattern.gap);
	};

	/** 取消所有尚未触发的响铃（测试收尾/插件卸载用）。 */
	const dispose = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};

	return { play, dispose };
}
