/**
 * dsh-notify-bell — SSE 推送 hub（playback: "browser"）。
 *
 * 职责：管理 DSH Web 客户端的 Server-Sent Events 长连接，把后端分类
 * 出的 semantic sound 推给浏览器播放。后端是唯一事件事实源——本模块
 * 不分类任何事件，只广播已分类的 sound。
 *
 * 协议：
 *   - 连接建立（GET /notify-bell/events）→ 立即写 `event: ready` 帧
 *     （enabled / playback / soundPack / version），浏览器据此知道
 *     服务端状态。
 *   - 通知 → `event: notify` 帧，data 为 { sound }（semantic sound）。
 *   - 心跳 → SSE 注释帧（`: hb`），避免 idle 连接被中间层掐断。
 *
 * 生命周期：
 *   - res 'close'（浏览器断开/页面关闭）→ 移出连接集合，广播自动跳过；
 *     连接数归零时停止心跳（省去空转定时器）。
 *   - dispose()（插件卸载/HMR）→ 停心跳、关闭全部连接。
 *   - 连接数有上限（maxConnections，默认 8），超限拒绝，防止异常
 *     客户端/多标签页无限累积。
 *   - 心跳定时器 unref，不阻塞进程退出。
 *
 * 本模块不依赖 DSH 服务，纯 node:http 响应对象操作，可单测。
 */
export function createSseHub(options = {}) {
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	// 类型/范围校验：NaN 会让上限退化失效，负数会拒绝全部连接。
	const maxConnections = Number.isSafeInteger(options.maxConnections) && options.maxConnections > 0
		? options.maxConnections
		: 8;
	const connections = new Set();
	let timer = null;

	/** 连接数归零时停止心跳。 */
	const stopHeartbeatIfIdle = () => {
		if (connections.size > 0) return;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	/** 广播一个 notify 帧（data 必须是 JSON 可序列化对象）。 */
	const broadcast = (data) => {
		const text = `event: notify\ndata: ${JSON.stringify(data)}\n\n`;
		for (const res of connections) {
			try {
				res.write(text);
			} catch {
				// 写失败（连接已断但 close 尚未触发）忽略，close 时会清理。
			}
		}
	};

	/**
	 * 接管一个 SSE 连接：写响应头 + ready 帧，登记到广播集合。
	 * 超过连接上限时返回 503 拒绝（不登记）。
	 * @param req - HTTP 请求（仅用于判断是否接受）。
	 * @param res - HTTP 响应（写头/写帧/监听 close）。
	 * @param ready - ready 帧载荷（enabled 等运行时状态，attach 时快照）。
	 */
	const attach = (req, res, ready = {}) => {
		if (connections.size >= maxConnections) {
			res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
			res.end('too many sse connections');
			return;
		}
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		});
		try {
			res.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
		} catch {
			// 连接已死：不登记，close 事件自会到达。
		}
		if (res.destroyed === true) return;
		connections.add(res);
		res.on('close', () => {
			connections.delete(res);
			stopHeartbeatIfIdle();
		});
	};

	/** 开始心跳（幂等；无连接时不启动，避免空转）。 */
	const start = () => {
		if (timer !== null || heartbeatMs <= 0) return;
		if (connections.size === 0) return;
		timer = setInterval(() => {
			const frame = `: hb ${Date.now()}\n\n`;
			for (const res of connections) {
				try {
					res.write(frame);
				} catch {
					// 同上：断开的连接由 close 清理。
				}
			}
		}, heartbeatMs);
		if (typeof timer.unref === 'function') timer.unref();
	};

	/** 停止心跳并关闭全部连接（插件卸载时调用）。 */
	const dispose = () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		for (const res of connections) {
			try {
				res.end();
			} catch {
				// 已关闭的连接忽略。
			}
		}
		connections.clear();
	};

	return {
		broadcast,
		attach,
		start,
		dispose,
		/** 当前连接数（诊断/测试用）。 */
		get connectionCount() {
			return connections.size;
		}
	};
}
