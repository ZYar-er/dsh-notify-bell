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
			".nb-bell-toggle{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:32px;height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:16px;justify-content:center;align-items:center;padding:0;display:inline-flex;flex:none}",
			".nb-bell-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".nb-bell-toggle:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".nb-bell-toggle svg{flex:none}"
		].join("\n");
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

		/** 把 (enabled, error) 映射为按钮视图（图标/文案/title/aria）。 */
		function bellView(enabled, error) {
			var on = enabled === true;
			return {
				icon: on ? "bell" : "bell-slash",
				label: on ? "Disable notifications" : "Enable notifications",
				title: error ? "Failed to update notifications setting" : (on ? "Disable notifications" : "Enable notifications"),
				pressed: on,
				ready: enabled !== null
			};
		}
		exports.bellView = bellView;
		//#endregion

		//#region 铃铛组件
		function BellIcon(props) {
			var muted = props.muted;
			return react.createElement(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 256 256", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": true, focusable: "false" },
				react.createElement("path", { d: muted ? PHOSPHOR_BELL_SLASH_PATH : PHOSPHOR_BELL_PATH, fill: "currentColor" })
			);
		}

		function BellToggleButton() {
			var state = react.useState({ enabled: null, error: false });
			var setState = state[1];

			react.useEffect(function () {
				bellRpc("getEnabled")
					.then(function (r) {
						if (r && r.ok) setState(function (s) { return { enabled: r.value.enabled, error: false }; });
					})
					.catch(function () {
						setState(function (s) { return s.enabled === null ? { enabled: true, error: false } : s; });
					});
			}, []);

			var toggle = react.useCallback(function () {
				setState(function (s) {
					if (s.enabled === null) return s;
					var before = s.enabled;
					// 乐观更新：立即翻转 UI。
					setState({ enabled: !before, error: false });
					bellRpc("toggle")
						.then(function (r) {
							if (r && r.ok) setState({ enabled: r.value.enabled, error: false });
							else setState({ enabled: before, error: true });
						})
						.catch(function () {
							setState({ enabled: before, error: true });
						});
					// 轻量错误提示：title 临时显示错误文案（3 秒后恢复）。
					if (s.error) setTimeout(function () { setState(function (cur) { return cur.error ? { enabled: cur.enabled, error: false } : cur; }); }, 3000);
					return s;
				});
			}, []);

			var view = bellView(state[0].enabled, state[0].error);
			return react.createElement(
				"button",
				{
					type: "button",
					className: "nb-bell-toggle",
					"aria-label": view.label,
					"aria-pressed": view.pressed,
					title: view.title,
					disabled: !view.ready,
					onClick: toggle
				},
				react.createElement(BellIcon, { muted: view.icon === "bell-slash" })
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
			error: "/notify-bell/sounds/error.wav"
		};

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
		/** 所需服务：插槽注册表（conversation.session.header.utilities）。 */
		var inject = ["slots"];

		/**
		 * 浏览器端插件主体：把铃铛注册进对话页顶栏工具区（Session log 按钮旁），
		 * 并在 playback=browser 时启动 SSE 播放器（后端推送 → 浏览器播放）。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-notify-bell");
				style.textContent = BUTTON_CSS;
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
						inject: function () { return {}; }
					}, BellToggleButton);
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
