// dsh-notify-bell — 浏览器端（client bundle）
//
// 对话页顶栏的铃铛（conversation.session.header.utilities 插槽，Session log 按钮旁）：
//   - bell（启用）/ bell-slash（禁用）——Phosphor Icons（regular weight）
//   - 点击 → POST /notify-bell/toggle → 后端运行时切换 enabled 并原子写入
//     ~/.config/dsh/notify-bell.json（保留其他字段）
//   - 初始状态 GET /notify-bell 读取（不假设 true）；写失败 UI 回滚 + title 错误提示
//
// 浏览器播放（playback=browser 实验）：
//   - EventSource /notify-bell/events：后端分类后推送 { sound }，
//     浏览器只负责播放（不复制分类逻辑；后端是唯一事件事实源）。
//   - Web Audio（AudioContext + buffer 缓存）；pointerdown/keydown
//     用户手势 unlock（resume）；未解锁时静默失败并记录 locked 状态，
//     不抛异常、不 fallback 到后端。
//   - 播放器实现与 src/browser-audio.js 同契约（参考实现，node 单测覆盖）。
//
// 本文件是打包产物格式的浏览器 bundle：注册到 window.__ModuleLoader__，
// 工厂函数内通过 require() 解析平台种子模块（react 等），
// 与官方 dsh-client-* 包发布的 client.js 结构一致。

window.__ModuleLoader__.load({
	id: "dsh-notify-bell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");

		//#region 图标（Phosphor Icons regular weight，256 viewBox，fill currentColor）
		var PHOSPHOR_BELL_PATH = "M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a64,64,0,1,1,128,0c0,36.05,8.28,66.73,16,80Z";
		var PHOSPHOR_BELL_SLASH_PATH = "M53.92,34.62A8,8,0,1,0,42.08,45.38L58.82,63.8A79.59,79.59,0,0,0,48,104c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.8a40,40,0,0,0,78.4,0h15.44l19.44,21.38a8,8,0,1,0,11.84-10.76ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216ZM48,184c7.7-13.24,16-43.92,16-80a63.65,63.65,0,0,1,6.26-27.62L168.09,184Zm166-4.73a8.13,8.13,0,0,1-2.93.55,8,8,0,0,1-7.44-5.08C196.35,156.19,192,129.75,192,104A64,64,0,0,0,96.43,48.31a8,8,0,0,1-7.9-13.91A80,80,0,0,1,208,104c0,35.35,8.05,58.59,10.52,64.88A8,8,0,0,1,214,179.25Z";
		//#endregion

		//#region 样式（与 Session log 按钮同风格：语义 token，双主题自适应）
		var BUTTON_CSS = [
			".nb-settings{position:relative;flex:none;display:inline-flex}",
			".nb-bell-toggle{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:32px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:16px;justify-content:center;align-items:center;padding:0;display:inline-flex;flex:none}",
			".nb-bell-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".nb-bell-toggle:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".nb-bell-toggle svg{flex:none}",
			".nb-bell-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}"
		].join("\n");
		// popover：右对齐浮层，紧凑、不遮挡主要内容。token 组合与 DSH 官方
		// menu surface 一致（--dsw-specific-menu / shadow-lv3 / border-inverted），
		// 浅色/深色由 body[data-ds-dark-theme] 的 token 覆盖自动适配。
		var POPOVER_CSS = [
			".nb-popover{box-sizing:border-box;position:absolute;top:calc(100% + 4px);right:0;z-index:1200;width:220px;max-width:calc(100vw - 24px);padding:6px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-specific-menu);border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);text-align:left}",
			".nb-popover-title{font-size:12px;line-height:16px;margin:4px 4px 2px;padding:2px 6px;color:var(--dsw-alias-label-tertiary)}",
			".nb-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px}",
			".nb-row svg{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}",
			".nb-row-label{flex:1;font-size:13px}",
			".nb-switch{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px;border-radius:12px;padding:2px 10px;cursor:pointer;line-height:1.6}",
			".nb-switch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".nb-switch:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".nb-switch[aria-checked=\"false\"]{color:var(--dsw-alias-label-secondary)}",
			".nb-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".nb-radio-group{padding:2px 4px;display:flex;flex-direction:column;gap:2px}",
			".nb-radio{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:6px;font-size:13px;cursor:pointer}",
			".nb-radio:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".nb-radio input{margin:0;accent-color:var(--dsw-alias-brand-primary)}",
			".nb-radio input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
			".nb-error{margin:6px 6px 2px;font-size:12px;color:var(--dsw-alias-state-error-primary)}"
		].join("\n");
		exports.POPOVER_CSS = POPOVER_CSS;
		//#endregion

		//#region Web → backend HTTP API
		/**
		 * 调用 notify-bell 开关端点。
		 * @param endpoint - 'getEnabled' | 'setEnabled' | 'toggle'。
		 * @param args - setEnabled 时 { enabled }。
		 * @returns { ok: true, value } 或 { ok: false, error }；网络失败抛错。
		 */
		function bellRpc(endpoint, args) {
			if (endpoint === "getEnabled") {
				return fetch("/notify-bell").then(function (res) { return res.json(); });
			}
			return fetch("/notify-bell/" + endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args || {})
			}).then(function (res) { return res.json(); });
		}
		exports.bellRpc = bellRpc;

		/** 把 (enabled, error) 映射为按钮视图（图标/文案/title/aria）。
		 * 按钮现在打开通知设置 popover（不再是直接 toggle）；图标只代表
		 * enabled 状态（bell / bell-slash），与 playback 无关。
		 * 按钮永不 disabled：初始 GET 失败时也可点击打开 popover 触发
		 * 重试（popover 内的控件在状态未加载时禁用）。
		 * @param t - 可选翻译函数（官方 locale seat）；缺失时英文 fallback。 */
		function bellView(enabled, error, t) {
			var on = enabled === true;
			var label = typeof t === "function" ? t("notifications") : "Notification settings";
			var title = typeof t === "function" ? (error ? t("failed") : t("notifications")) : (error ? "Failed to update notifications setting" : "Notification settings");
			return {
				icon: on ? "bell" : "bell-slash",
				label: label,
				title: title,
				pressed: on,
				ready: true
			};
		}
		exports.bellView = bellView;

		//#region 设置视图纯函数（node 测试覆盖同一契约）
		/** 中英文案字典；语言跟随页面（html lang），不自行切换。 */
		var SETTINGS_I18N = {
			en: { notifications: "Notifications", on: "On", off: "Off", playback: "Playback", browser: "Browser", backend: "Backend", none: "None", failed: "Failed to update settings" },
			zh: { notifications: "通知", on: "开启", off: "关闭", playback: "播放方式", browser: "浏览器", backend: "后端", none: "静音", failed: "设置更新失败" }
		};
		exports.SETTINGS_I18N = SETTINGS_I18N;

		/** playback 选项顺序（radio group 显示顺序）。 */
		var PLAYBACK_OPTIONS = [
			{ value: "browser", key: "browser" },
			{ value: "backend", key: "backend" },
			{ value: "none", key: "none" }
		];
		exports.playbackOptions = PLAYBACK_OPTIONS;

		/** 语言检测：html lang 优先，navigator 兜底；zh 以外按 en。 */
		function detectLang(htmlLang, navLang) {
			if (typeof htmlLang === "string" && /^zh/i.test(htmlLang)) return "zh";
			if (typeof htmlLang === "string" && htmlLang.length > 0) return "en";
			if (typeof navLang === "string" && /^zh/i.test(navLang)) return "zh";
			return "en";
		}
		exports.detectLang = detectLang;

		/**
		 * 完整设置视图映射（纯函数）：开关文案、radio 选中态、错误提示。
		 * @param enabled - 后端运行时 enabled（null = 未加载）。
		 * @param playback - 后端运行时 playback（null = 未加载）。
		 * @param lang - 'en' | 'zh'。
		 * @param error - 是否有写失败错误。
		 */
		function settingsView(enabled, playback, lang, error) {
			var t = SETTINGS_I18N[lang] || SETTINGS_I18N.en;
			var playbacks = PLAYBACK_OPTIONS.map(function (opt) {
				return { value: opt.value, label: t[opt.key], checked: playback === opt.value };
			});
			return {
				bellIcon: enabled === true ? "bell" : "bell-slash",
				enabledReady: enabled !== null,
				playbackReady: typeof playback === "string",
				enabledOn: enabled === true,
				switchLabel: enabled === true ? t.on : t.off,
				title: t.notifications,
				playbackTitle: t.playback,
				playbacks: playbacks,
				errorText: error ? t.failed : "",
				lang: lang
			};
		}
		exports.settingsView = settingsView;

		/** Escape 键关闭 popover（open 时才响应）。 */
		function closeOnEscape(open, key) {
			return open === true && key === "Escape";
		}
		exports.closeOnEscape = closeOnEscape;

		/** 外部点击关闭：target 既不在按钮内也不在 popover 内。 */
		function closeOnOutside(open, target, buttonEl, popoverEl) {
			if (open !== true) return false;
			if (!target || typeof target.nodeType !== "number") return false;
			var inButton = buttonEl && typeof buttonEl.contains === "function" && buttonEl.contains(target);
			var inPopover = popoverEl && typeof popoverEl.contains === "function" && popoverEl.contains(target);
			return !inButton && !inPopover;
		}
		exports.closeOnOutside = closeOnOutside;
		//#endregion
		//#endregion

		//#region 铃铛组件（通知设置 popover）
		function BellIcon(props) {
			var muted = props.muted;
			return react.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 256 256", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, focusable: "false" },
				react.createElement("path", { d: muted ? PHOSPHOR_BELL_SLASH_PATH : PHOSPHOR_BELL_PATH, fill: "currentColor" })
			);
		}

		/**
		 * 铃铛按钮 + 通知设置 popover：
		 *   - 点击铃铛打开/关闭 popover（不再直接 toggle）。
		 *   - 通知开关（On/Off）→ POST setEnabled，乐观更新 + 失败回滚。
		 *   - 播放方式 radio（Browser/Backend/None）→ POST setPlayback，乐观更新 + 失败回滚。
		 *   - 初始状态 GET /notify-bell 一次拿 enabled + playback（backend 是唯一事实源）。
		 *   - 外部点击 / Escape 关闭；原生 radio 提供键盘操作（方向键 + 空格）。
		 */
		function BellSettingsButton(props) {
			var refs = react.useRef({ button: null, popover: null });
			var state = react.useState({ enabled: null, playback: null, error: false, open: false });
			var setState = state[1];
			var current = state[0];

			// 翻译：优先 slots 的官方 locale seat（DSH 语言状态是唯一事实源，
			// 切换即时重渲染）；locale 未安装时 fallback 到字典 + html lang 检测。
			var lang = detectLang(
				typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "",
				typeof navigator !== "undefined" && navigator.language ? navigator.language : ""
			);
			var tr = typeof props.t === "function" ? props.t : function (key) { return SETTINGS_I18N[lang][key]; };

			/** 拉取后端运行时状态（enabled + playback）；失败置 error 供重试。 */
			var refresh = react.useCallback(function () {
				bellRpc("getEnabled")
					.then(function (r) {
						if (r && r.ok) setState(function (s) { return { enabled: r.value.enabled, playback: r.value.playback, error: false, open: s.open }; });
						else setState(function (s) { return { enabled: s.enabled, playback: s.playback, error: true, open: s.open }; });
					})
					.catch(function () {
						setState(function (s) { return { enabled: s.enabled, playback: s.playback, error: true, open: s.open }; });
					});
			}, []);

			// 初始加载：GET 一次拿 enabled + playback（不假设任何默认值）。
			react.useEffect(function () {
				refresh();
			}, [refresh]);

			// 打开 popover 时若后端状态尚未加载成功（初始 GET 失败）→ 重试；
			// 避免按钮永久 disabled 且无恢复入口。
			react.useEffect(function () {
				if (current.open && (current.enabled === null || typeof current.playback !== "string")) refresh();
			}, [current.open, current.enabled, current.playback, refresh]);

			// popover 打开时：document 级外部点击 / Escape 关闭（关闭即移除监听）。
			react.useEffect(function () {
				if (!current.open) return;
				var onPointer = function (event) {
					if (closeOnOutside(true, event.target, refs.current.button, refs.current.popover)) {
						setState(function (s) { return { enabled: s.enabled, playback: s.playback, error: s.error, open: false }; });
					}
				};
				var onKey = function (event) {
					if (closeOnEscape(true, event.key)) {
						setState(function (s) { return { enabled: s.enabled, playback: s.playback, error: s.error, open: false }; });
					}
				};
				document.addEventListener("pointerdown", onPointer, true);
				document.addEventListener("keydown", onKey, true);
				return function () {
					document.removeEventListener("pointerdown", onPointer, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [current.open]);

			/** 轻量错误提示：popover 内 error 文案，3 秒后自动恢复。
			 *  timer 存入 ref，组件卸载时清理（不悬挂 setTimeout）。 */
			var errorTimer = react.useRef(null);
			var flagError = function () {
				if (errorTimer.current !== null) clearTimeout(errorTimer.current);
				errorTimer.current = setTimeout(function () {
					errorTimer.current = null;
					setState(function (s) { return s.error ? { enabled: s.enabled, playback: s.playback, error: false, open: s.open } : s; });
				}, 3000);
			};
			react.useEffect(function () {
				return function () {
					if (errorTimer.current !== null) clearTimeout(errorTimer.current);
				};
			}, []);

			var setEnabledOpt = function (next) {
				var before = current.enabled;
				if (before === null) return;
				// 乐观更新：立即翻转 UI；失败回滚 + 错误提示。
				setState({ enabled: next, playback: current.playback, error: false, open: true });
				bellRpc("setEnabled", { enabled: next })
					.then(function (r) {
						if (r && r.ok) setState(function (s) { return { enabled: r.value.enabled, playback: s.playback, error: false, open: true }; });
						else { setState(function (s) { return { enabled: before, playback: s.playback, error: true, open: true }; }); flagError(); }
					})
					.catch(function () {
						setState(function (s) { return { enabled: before, playback: s.playback, error: true, open: true }; });
						flagError();
					});
			};

			var setPlaybackOpt = function (next) {
				var before = current.playback;
				if (typeof before !== "string") return;
				// 乐观更新：立即选中；失败回滚 + 错误提示。
				setState({ enabled: current.enabled, playback: next, error: false, open: true });
				bellRpc("setPlayback", { playback: next })
					.then(function (r) {
						if (r && r.ok) setState(function (s) { return { enabled: s.enabled, playback: r.value.playback, error: false, open: true }; });
						else { setState(function (s) { return { enabled: s.enabled, playback: before, error: true, open: true }; }); flagError(); }
					})
					.catch(function () {
						setState(function (s) { return { enabled: s.enabled, playback: before, error: true, open: true }; });
						flagError();
					});
			};

			// 渲染视图映射（与 settingsView 同契约；文案经官方 t 翻译）。
			var enabledOn = current.enabled === true;
			var playbacks = PLAYBACK_OPTIONS.map(function (opt) {
				return { value: opt.value, label: tr(opt.key), checked: current.playback === opt.value };
			});
			var title = tr("notifications");
			var playbackTitle = tr("playback");
			var switchLabel = enabledOn ? tr("on") : tr("off");
			var errorText = current.error ? tr("failed") : "";
			var bell = bellView(current.enabled, current.error, tr);
			var bellIcon = enabledOn ? "bell" : "bell-slash";

			return react.createElement(
				"div",
				{ className: "nb-settings" },
				react.createElement(
					"button",
					{
						type: "button",
						ref: function (el) { refs.current.button = el; },
						className: "nb-bell-toggle",
						"aria-label": bell.label,
						"aria-haspopup": "dialog",
						"aria-expanded": current.open ? "true" : "false",
						title: bell.title,
						disabled: !bell.ready,
						onClick: function () {
							setState(function (s) { return { enabled: s.enabled, playback: s.playback, error: s.error, open: !s.open }; });
						}
					},
					react.createElement(BellIcon, { muted: bellIcon === "bell-slash" })
				),
				current.open ? react.createElement(
					"div",
					{
						ref: function (el) { refs.current.popover = el; },
						className: "nb-popover",
						role: "dialog",
						"aria-label": title
					},
					react.createElement("div", { className: "nb-popover-title" }, title),
					react.createElement(
						"div",
						{ className: "nb-row" },
						react.createElement(BellIcon, { muted: !enabledOn }),
						react.createElement("span", { className: "nb-row-label" }, title),
						react.createElement(
							"button",
							{
								type: "button",
								className: "nb-switch",
								role: "switch",
								"aria-checked": enabledOn ? "true" : "false",
								disabled: current.enabled === null,
								onClick: function () { setEnabledOpt(!enabledOn); }
							},
							switchLabel
						)
					),
					react.createElement("div", { className: "nb-popover-title" }, playbackTitle),
					react.createElement(
						"div",
						{ className: "nb-radio-group", role: "radiogroup", "aria-label": playbackTitle },
						playbacks.map(function (opt) {
							return react.createElement(
								"label",
								{ className: "nb-radio", key: opt.value },
								react.createElement("input", {
									type: "radio",
									name: "nb-playback",
									value: opt.value,
									checked: opt.checked,
									disabled: typeof current.playback !== "string",
									onChange: function () { setPlaybackOpt(opt.value); }
								}),
								react.createElement("span", null, opt.label)
							);
						})
					),
					errorText ? react.createElement("div", { className: "nb-error", role: "status" }, errorText) : null
				) : null
			);
		}
		//#endregion

		//#region 浏览器播放器（playback=browser 实验）
		// 与 src/browser-audio.js 同一契约的内联实现（打包 bundle 无法 import
		// 源模块，两者必须保持行为一致；src/browser-audio.js 是参考实现并被
		// node 单测覆盖）。后端是唯一事件事实源：SSE 推送什么就播什么，
		// 这里不复制任何分类逻辑。
		//
		// autoplay 策略：AudioContext 在用户手势（pointerdown/keydown）中
		// 创建/resume 后才会 running；未解锁时播放静默失败并记录状态，
		// 不抛异常、不影响 DSH 页面、不 fallback 到后端。
		var SOUND_URLS = {
			done: "/notify-bell/sounds/done.wav",
			permission: "/notify-bell/sounds/permission.wav",
			question: "/notify-bell/sounds/question.wav",
			block: "/notify-bell/sounds/block.wav",
			error: "/notify-bell/sounds/error.wav",
			default: "/notify-bell/sounds/done.wav"
		};
		exports.SOUND_URLS = SOUND_URLS;

		/** 创建播放器：懒建 AudioContext、buffer 缓存、locked 诊断状态。 */
		function createPlayer() {
			var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
			var player = {
				ctx: null,
				buffers: {},
				unlockDisposer: null,
				state: { locked: true, ready: false, enabled: true, lastError: "", plays: 0 }
			};
			player.ensureCtx = function () {
				if (player.ctx !== null) return player.ctx;
				if (!AudioContextCtor) {
					player.state.lastError = "AudioContext unavailable";
					return null;
				}
				try {
					player.ctx = new AudioContextCtor();
				} catch (error) {
					player.ctx = null;
					player.state.lastError = "AudioContext creation failed: " + (error && error.message ? error.message : String(error));
					return null;
				}
				return player.ctx;
			};
			player.unlock = function () {
				var audio = player.ensureCtx();
				if (audio === null) return Promise.resolve(false);
				return Promise.resolve()
					.then(function () {
						if (audio.state === "suspended") return audio.resume();
					})
					.then(function () {
						var ok = audio.state === "running";
						if (ok) {
							player.state.locked = false;
							player.state.lastError = "";
							player.removeUnlockListeners();
						}
						return ok;
					})
					.catch(function (error) {
						player.state.lastError = "resume failed: " + (error && error.message ? error.message : String(error));
						return false;
					});
			};
			player.loadBuffer = function (audio, url) {
				var cached = player.buffers[url];
				if (cached !== undefined) return Promise.resolve(cached);
				return fetch(url)
					.then(function (response) {
						if (!response.ok) throw new Error("fetch " + url + " -> " + response.status);
						return response.arrayBuffer();
					})
					.then(function (arrayBuffer) { return audio.decodeAudioData(arrayBuffer); })
					.then(function (buffer) {
						player.buffers[url] = buffer;
						return buffer;
					});
			};
			player.playSound = function (sound) {
				var url = SOUND_URLS[sound];
				if (typeof sound !== "string" || url === undefined) {
					player.state.lastError = "unknown sound: " + String(sound);
					return Promise.resolve(false);
				}
				var audio = player.ensureCtx();
				if (audio === null) return Promise.resolve(false);
				if (audio.state !== "running") {
					player.state.locked = true;
					player.state.lastError = "autoplay locked (ctx " + audio.state + "); unlock with a user gesture";
					return Promise.resolve(false);
				}
				return player.loadBuffer(audio, url)
					.then(function (buffer) {
						var source = audio.createBufferSource();
						source.buffer = buffer;
						source.connect(audio.destination);
						source.start();
						player.state.plays += 1;
						player.state.locked = false;
						player.state.lastError = "";
						return true;
					})
					.catch(function (error) {
						player.state.lastError = "play failed: " + (error && error.message ? error.message : String(error));
						return false;
					});
			};
			player.handleFrame = function (event, data) {
				if (event === "ready") {
					player.state.ready = true;
					if (data && typeof data.enabled === "boolean") player.state.enabled = data.enabled;
					console.debug("[notify-bell] browser audio ready:", JSON.stringify(data));
					return;
				}
				if (event === "notify") {
					if (!player.state.enabled) return;
					player.playSound(data && data.sound);
					return;
				}
				player.state.lastError = "unknown sse event: " + String(event);
			};
			player.removeUnlockListeners = function () {
				if (player.unlockDisposer !== null) {
					var dispose = player.unlockDisposer;
					player.unlockDisposer = null;
					dispose();
				}
			};
			player.attachUnlockListeners = function () {
				if (player.unlockDisposer !== null) return;
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return; // 非浏览器环境（node 测试）跳过
				var handler = function () { player.unlock(); };
				window.addEventListener("pointerdown", handler, true);
				window.addEventListener("keydown", handler, true);
				player.unlockDisposer = function () {
					window.removeEventListener("pointerdown", handler, true);
					window.removeEventListener("keydown", handler, true);
				};
			};
			player.dispose = function () {
				player.removeUnlockListeners();
				player.buffers = {};
				if (player.ctx !== null) {
					try { player.ctx.close(); } catch (error) { /* 忽略关闭失败 */ }
					player.ctx = null;
				}
			};
			return player;
		}

		/** 建立 SSE 连接；EventSource 断线自动重连（浏览器内置）。 */
		function connectSse(player) {
			if (typeof EventSource === "undefined") return null; // 非浏览器环境（node 测试）
			var es = new EventSource("/notify-bell/events");
			es.addEventListener("ready", function (event) {
				var data = null;
				try { data = JSON.parse(event.data); } catch (error) { /* 忽略坏帧 */ }
				player.handleFrame("ready", data);
			});
			es.addEventListener("notify", function (event) {
				var data = null;
				try { data = JSON.parse(event.data); } catch (error) {
					player.state.lastError = "bad sse payload";
					return;
				}
				player.handleFrame("notify", data);
			});
			es.onerror = function () {
				player.state.lastError = "sse connection error (will reconnect)";
			};
			return es;
		}
		//#endregion

		//#region 插件入口
		/**
		 * 所需服务：插槽注册表（conversation.session.header.utilities）+ DSH
		 * locale 服务（语言状态唯一事实源：注册字典 + slot locale seat）。
		 */
		var inject = ["slots", "locale"];

		/**
		 * 浏览器端插件主体：注册中英文字典、把铃铛（通知设置 popover）
		 * 注册进对话页顶栏工具区（Session log 按钮旁），并在 playback=browser
		 * 时启动 SSE 播放器（后端推送 → 浏览器播放）。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			// DSH 官方 locale 字典注册（zh/en 与 SETTINGS_I18N 同源）。
			// 必须放进 ctx.effect：返回的 disposer 随 fiber 卸载时移除
			// namespace，否则客户端 HMR 重载后二次 register 会抛
			// "locale namespace ... already has locale"（locale 服务跨 reload 存活）。
			// locale 未安装时跳过，组件 fallback 到 html lang 检测。
			ctx.effect(function () {
				if (!ctx.locale || typeof ctx.locale.register !== "function") return;
				return ctx.locale.register("notify-bell", SETTINGS_I18N);
			}, "dsh-notify-bell: locale");

			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-notify-bell");
				style.textContent = BUTTON_CSS + "\n" + POPOVER_CSS;
				document.head.append(style);
				return function () { style.remove(); };
			}, "dsh-notify-bell: styles");

			ctx.effect(function () {
				var player = createPlayer();
				player.attachUnlockListeners();
				var es = connectSse(player);
				// 解锁状态只在 console 记录（可诊断），本阶段不增加新 UI。
				console.debug("[notify-bell] browser playback started (locked=" + player.state.locked + ")");
				return function () {
					if (es !== null) es.close();
					player.dispose();
				};
			}, "dsh-notify-bell: browser audio");

			ctx.effect(function () {
				return ctx.slots.inject("conversation.session.header.utilities", function () {
					var dispose = ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "notify-bell-toggle",
						order: 90,
						locale: "notify-bell",
						inject: function () { return {}; }
					}, BellSettingsButton);
					return function () { dispose(); };
				});
			}, "dsh-notify-bell: bell entry");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
