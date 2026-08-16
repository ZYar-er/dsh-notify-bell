# Changelog

dsh-notify-bell 版本级、面向用户的变化记录。历史条目与对应的 GitHub Release 文案保持一致，不会被后续版本覆盖。

## [Unreleased]

### Added

- `playback: "browser"` 实验：后端分类后经 SSE（`/notify-bell/events`）推送 semantic sound，DSH Web 浏览器用 Web Audio 播放对应 WAV（`/notify-bell/sounds/*.wav` 直接服务 sound-showcase 素材）。事件分类始终在后端；browser 模式下本机后端不播放。含用户手势 unlock（AudioContext resume）与 locked 诊断状态。

## [0.11.2] - 2026-08-16

### Added

- `/notify-bell` HTTP API 的成功响应新增 `version` 字段（来自 package.json，`PLUGIN_VERSION`），可在运行时确认安装的插件版本。

## [0.11.1] - 2026-08-16

### Fixed

- Complete 通知改为严格“最终回答”判定：最后一个 `assistant/message` 必须包含非空 `text` block，且其后不得再出现 `tool/call`。tool-call-only、concludes-turn 与空 no-op 回合保持完全静默。
- 通知去重状态改为有界容器（FIFO 淘汰），并在 `session/disposed` 时回收，避免长会话内存无界增长。

### Added

- 基于真实 DSH SessionStore 的会话层集成测试（`src/session-layer.test.js`）。

### Changed

- README 与源码注释对齐严格的 final-answer 完成语义。

## [0.11.0] - 2026-08-16

### Changed

- Complete 通知改由 `turn/end`（`reason.kind = completed`）触发：最终 assistant 回合结束时通知，不再依赖 goal 完成。
- 完成时长按 `turn/start` 到 `turn/end` 计算。
- 完成日志展示用户请求摘要。

### Added

- 按 `delegationDepth` 排除子代理回合，只有主会话触发通知。
- sound-showcase 声音试听页（中英文页面、语言切换、品牌图标 #4176e6）。

### Fixed

- goal 完成不再重复触发 done 通知（`goal/changed` 的 `operation = complete` 静默）。

### Compatibility

- DSH 仍处于 Developer Preview；上游插件/事件 API 可能变化。

## [0.10.0] - 2026-08-16

### Added

- 语义化通知：complete、approval、question、block、error 五种事件，各自独立语义声音。
- 官方 Cordis 插件形态：导出 `Config` schema（非法配置加载即失败）+ `dsh.bundle` patch。
- WAV 声音包，以及自动 BEL fallback。
- Windows / WSL（PowerShell + System.Media.SoundPlayer）与 Linux（paplay / pw-play / aplay / ffplay 探测）音频播放。
- DSH Web UI 运行时静音/开启（Phosphor `bell` / `bell-slash` 按钮）。
- 浅色/深色主题适配。
- 首次发布到 npm（`dsh-notify-bell@0.10.0`）。

### Compatibility

- Developer Preview 发布，面向社区测试与反馈。
