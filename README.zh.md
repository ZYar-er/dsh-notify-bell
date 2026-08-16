# dsh-notify-bell

[English](./README.md) | [中文](./README.zh.md) | [Changelog](./CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-notify-bell)](https://www.npmjs.com/package/dsh-notify-bell) [![GitHub Release](https://img.shields.io/github/v/release/ZYar-er/dsh-notify-bell)](https://github.com/ZYar-er/dsh-notify-bell/releases/latest)

<p align="center">
  <img src="https://raw.githubusercontent.com/ZYar-er/dsh-notify-bell/main/dsh-notify-bell-cover/readme-cover.zh.png" alt="dsh-notify-bell — DSH 语义通知插件" width="100%" />
</p>

**DeepSeek Harness (DSH) 社区插件**，为重要的 Agent 事件提供语义化提示音通知。

> **Developer Preview · v0.12.0**

🎧 **[试听通知声音 →](https://zyar-er.github.io/dsh-notify-bell/sound-showcase/)**

dsh-notify-bell 让你不必一直盯着 DSH Web 页面，也不会错过 Agent 真正需要你介入的时刻。

它不会对每一个内部事件都发出通知，而是专注于这些需要用户注意的状态：

- ✓ **完成** — Agent 完成了最终回答
- 🔐 **审批** — 某个工具操作需要你的批准
- ❓ **提问** — Agent 正在等待你的回答
- ⚠ **受阻** — 当前目标无法继续
- ✗ **错误** — Agent 遇到了一次 Agent 级错误

每种事件都有独立的语义声音，而不是靠“重复响几声”来表达含义。

## 特性

- 支持完成、审批、提问、受阻、错误五种语义通知
- DSH Web 浏览器播放
- Windows、WSL、Linux 本机播放
- DSH Web 一键静音/开启
- 播放方式选择：**浏览器 / 后端 / 静音**
- 浅色/深色主题适配
- Phosphor `bell` / `bell-slash` 通知按钮
- WAV 声音包
- 后端播放的 BEL fallback
- 可配置的通知声音
- 可配置的完成通知最短时长
- 官方 DSH Cordis 插件形态，带 schema 校验
- 除官方 `@deepseek-ai/schemastery` 外，无其他运行时依赖

## 安装

从 npm 安装：

```bash
dsh plugin --profile web add dsh-notify-bell
```

`dsh plugin add` 会安装包并把它追加到 profile 的
`dsh.profile.bundles`，下次启动时自动应用 bundle 层。如果 `dsh web`
正在运行，重启即可。

### 从源码 / GitHub 安装

在仓库检出目录中：

```bash
dsh plugin --profile web add ./dsh-notify-bell
```

开发版本或源码测试，可以直接从 GitHub 安装：

```bash
dsh plugin --profile web add github:zyar-er/dsh-notify-bell#<commit-sha>
```

直接从 GitHub 安装时，建议固定 commit 以保证供应链安全。

## 快速开始

启动 DSH Web 后，**Session log** 旁会出现通知铃铛：

```text
Session log   🔔
```

点击铃铛打开通知设置。

![通知设置弹层](./sound-showcase/assets/settings-menu-zh.png)

你可以控制：

- **通知** — 开启或关闭所有通知声音
- **播放方式** — 选择声音在哪里播放：
  - **浏览器**
  - **后端**
  - **静音**

更改立即生效并自动持久化。

## 播放方式

### 浏览器

DSH Web 推荐使用。

后端负责分类通知事件，并通过 SSE 把语义声音事件推送到浏览器，浏览器用 Web Audio 播放包内自带的 WAV 文件。

```text
DSH 后端
   ↓
SSE
   ↓
DSH Web
   ↓
Web Audio
   ↓
WAV
```

受浏览器 autoplay 策略限制，首次出声前需要先与页面有一次正常的用户交互。

解锁之后，即使把 DSH 标签页放在后台、在别的标签页工作，也仍然可以播放。

浏览器播放**不**使用浏览器 Notification API，也不需要通知权限。

### 后端

声音在本机播放，而不是在浏览器内播放。

Windows 与 WSL：

```text
PowerShell
  → System.Media.SoundPlayer
  → Windows Audio
```

Linux 按以下顺序自动探测可用播放器：

```text
paplay
pw-play
aplay
ffplay
```

WAV 无法播放时，如果存在可用 TTY，后端播放可以 fallback 到终端 BEL。

### 静音

只输出通知日志，不播放任何声音。

### 选择播放方式

可以在通知设置弹层里随时切换播放方式，无需重启 DSH。

配置：

```json
{
  "playback": "browser"
}
```

可选值：

```text
browser
backend
none
```

目前没有自动的浏览器 → 后端 fallback，也没有 `both` 模式。所选模式是有意为之：一条通知只由一个播放后端处理。

## 通知声音

| 事件 | 声音 | 来源 | 时长 |
| --- | --- | --- | ---: |
| ✓ 完成 | `ui/success_bling` | react-sounds | 0.76s |
| 🔐 审批 | `notification/notification` | react-sounds | 0.86s |
| ❓ 提问 | `notification/info` | react-sounds | 0.86s |
| ⚠ 受阻 | `ui/blocked` | react-sounds | 0.89s |
| ✗ 错误 | `notification/error` | react-sounds | 0.55s |

🎧 **[试听全部声音](https://zyar-er.github.io/dsh-notify-bell/sound-showcase/)**

每种通知都有独立的声音标识，而不是靠重复响铃次数来区分。

## 配置

插件遵循官方 DSH Cordis 配置模型，并导出 Schemastery `Config` schema：
profile 的 `cordis.patch.yml` 中插件行的 `config` 块会在加载时被校验并
填充默认值，非法配置直接加载失败。

示例（profile patch）：

```yaml
- id: notify-bell
  config:
    minDuration: 10
    playback: backend
```

legacy 运行时状态文件位于：

```text
~/.config/dsh/notify-bell.json
```

其路径可以用以下环境变量覆盖：

```text
DSH_NOTIFY_BELL_CONFIG
```

Web 界面会把 `enabled` 与 `playback` 持久化到这里。示例文件：

```json
{
  "enabled": true,
  "minDuration": 10,
  "objective": {
    "maxLength": 120
  },
  "events": {
    "complete": {
      "enabled": true,
      "sound": "done"
    },
    "block": {
      "enabled": true,
      "sound": "block"
    },
    "approval": {
      "enabled": true,
      "sound": "permission"
    },
    "question": {
      "enabled": true,
      "sound": "question"
    },
    "error": {
      "enabled": true,
      "sound": "error"
    }
  },
  "soundPack": "wav",
  "playback": "browser",
  "wav": {
    "directory": "~/.config/dsh/notify-bell/sounds",
    "fallback": "bell"
  },
  "bell": {
    "gapMs": 150,
    "permissionGapMs": 300
  }
}
```

### 完成任务的最短时长

运行时间短于 `minDuration` 的任务不播放完成声音。

审批和提问不受该限制，因为这两种状态意味着 Agent 正在等待用户处理。

### 运行时静音

`enabled` 控制所有通知播放。

关闭后：

- 不向浏览器推送声音
- 本机不播放声音
- DSH 继续正常运行
- 其他配置保持不变
- 无需重启

### 配置来源

显式插件配置优先于 legacy 运行时状态文件：

```text
cordis 配置  >  notify-bell.json  >  schema 默认值
```

对普通用户来说，通过 Web 界面修改通知状态和播放方式是最方便的方式。

## 事件行为

### 完成

完成通知意味着 Agent 已经完成当前回合的最终回答。

通知依据：

```text
session/event
type = turn/end
data.reason.kind = completed
```

该回合必须包含真正的最终 assistant 文本回答。空 no-op 回合与
tool-call-only 的 `concludesTurn` 结束不会触发完成声音。

子代理回合会被忽略。

完成时长按：

```text
turn/start.time → turn/end.time
```

计算。短于 `minDuration` 的请求只记录日志，不播放完成声音。

### 审批

监听：

```text
approval/asked
```

表示某个工具操作正在等待用户批准。

`approval/decided` 不会再次通知。

### 提问

当 Agent 调用：

```text
ask_user_question
```

时触发，表示 Agent 正在等待用户回答。

用户回答本身不会再次通知。

### 受阻

监听：

```text
goal/changed
operation = block
```

### 错误

监听：

```text
agent/error
```

这里表示 Agent 层面的错误。普通 shell 命令返回非零退出码不一定会产生此事件。

## 平台支持

### Windows / WSL

使用 DSH Web 时推荐浏览器播放。

后端播放使用：

```text
PowerShell
  → System.Media.SoundPlayer
  → Windows Audio
```

### Linux

后端播放自动探测：

```text
paplay
pw-play
aplay
ffplay
```

插件不会自动安装任何播放器。

## 开发者文档

以下内容主要面向贡献者与插件开发者。

### 官方 DSH 插件形态

dsh-notify-bell 遵循官方 DSH 插件规范。

本包：

- 导出 Schemastery `Config` schema
- 使用官方 Cordis 插件形态
- 通过 `dsh.bundle` 声明自己的 bundle patch
- 通过 `dsh.client` 提供 Web 客户端
- 使用 `cordis.patch.yml`，无需手动编辑 profile patch

官方 DSH 插件文档：

https://deepseek-harness.github.io/deepseek-harness/develop/basic/

### 架构

```text
DSH 会话事件
        ↓
事件分类
        ↓
semantic sound
        ↓
playback
   ┌────┼───────┐
   ↓    ↓       ↓
browser backend none
   ↓      ↓
  SSE    audio
   ↓      ├─ WAV
  Web      └─ BEL fallback
  Audio
```

事件层与物理音频后端相互独立。

语义声音：

```text
done
permission
question
block
error
```

### 浏览器后端

浏览器模式的数据流：

```text
session event
    ↓
服务端分类
    ↓
SSE: /notify-bell/events
    ↓
client.js
    ↓
Web Audio
    ↓
包内 WAV
```

浏览器不会重复实现事件分类逻辑。

### 后端音频

后端模式复用现有平台音频抽象：

```text
Windows / WSL
→ PowerShell + SoundPlayer

Linux
→ paplay
→ pw-play
→ aplay
→ ffplay

失败
→ BEL fallback
```

### Web 客户端

Web 客户端通过 DSH 客户端模块系统加载，把通知控件注册在 Session log 旁。

通知设置弹层控制：

- `enabled`
- `playback`

运行时状态原子持久化到 legacy 配置文件。

## 测试

项目包含单元测试与会话层集成测试。

当前测试状态：

**全部通过 — 11 个 `node:test` 用例（6 个单元 + 5 个会话层集成），单元脚本内含 179 项断言检查。**

已完成真实验证：

- 任务完成
- 审批请求
- 用户提问
- Web UI 静音/开启
- 浏览器播放
- 后台标签页浏览器播放
- WSL → Windows WAV 播放
- 后端播放
- 播放方式切换

错误通知路径由自动化测试覆盖，不需要通过故意破坏 credentials 来验证。

## Developer Preview

DSH 仍处于 Developer Preview 阶段，上游插件与事件 API 可能变化。

dsh-notify-bell 是社区插件，不是 DeepSeek 官方插件。

欢迎社区重点测试：

- Windows 原生
- WSL
- Linux 音频播放
- 浏览器播放
- 后台标签页播放
- 审批通知
- 提问通知
- 声音音量与长期使用体验
- 配置兼容性
- DSH 上游变化

提交 Issue 时，请附上：

- DSH 版本
- 操作系统/环境
- 播放方式
- 触发的通知事件
- 预期行为
- 实际行为
- 重现步骤

## 致谢

声音素材来自 [react-sounds](https://github.com/e3ntity/react-sounds)。

图标使用 [Phosphor Icons](https://phosphoricons.com/)。

本项目为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供通知能力。

## 许可证

dsh-notify-bell 的源代码采用
[MIT License](./LICENSE) 授权。

本项目同时分发第三方声音及图标素材。
相关授权和署名信息请参阅 [NOTICE.md](./NOTICE.md)。
