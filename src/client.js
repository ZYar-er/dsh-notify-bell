// dsh-notify-bell — 浏览器端（client bundle）
//
// 对话页顶栏的铃铛（conversation.session.header.utilities 插槽，Session log 按钮旁）：
//   - bell（启用）/ bell-slash（禁用）——Phosphor Icons（regular weight）
//   - 点击 → POST /notify-bell/toggle → 后端运行时切换 enabled 并原子写入
//     ~/.config/dsh/notify-bell.json（保留其他字段）
//   - 初始状态 GET /notify-bell 读取（不假设 true）；写失败 UI 回滚 + title 错误提示
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

		//#region 插件入口
		/** 所需服务：插槽注册表（conversation.session.header.utilities）。 */
		var inject = ["slots"];

		/**
		 * 浏览器端插件主体：把铃铛注册进对话页顶栏工具区（Session log 按钮旁）。
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
