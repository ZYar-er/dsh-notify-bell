# dsh-notify-bell

[English](./README.md) | [中文](./README.zh.md)

![npm](https://img.shields.io/npm/v/dsh-notify-bell)

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 提供语义化提示音通知。

> **Developer Preview · v0.10.0**

🎧 **[试听通知声音 →](https://zyar-er.github.io/dsh-notify-bell/sound-showcase/)**

dsh-notify-bell 让你不必一直盯着 DSH Web 页面，也不会错过 Agent 真正需要你介入的时刻。

它不会对每一个内部事件都发出通知，而是专注于这些需要用户注意的状态：

- ✓ **完成** — 任务已经完成
- 🔐 **审批** — 某个工具操作需要你的批准
- ❓ **提问** — Agent 正在等待你的回答
- ⚠ **受阻** — 当前目标无法继续
- ✗ **错误** — Agent 遇到了错误

每种事件都有独立的语义声音，而不是通过“响几声”来表达不同含义。

## 特性

- 支持完成、审批、提问、受阻、错误五种语义通知
- 官方 Cordis 插件规范：导出 `Config` schema（非法配置加载即失败）+ `dsh.bundle` patch
- WAV 声音包
- BEL 提示音 fallback
- Windows 原生音频播放
- WSL → Windows 音频播放
- Linux 原生音频播放
- DSH Web 内运行时静音/开启
- 浅色/深色主题适配
- Phosphor `bell` / `bell-slash` 图标
- 每个事件可以独立配置声音
- 可设置完成任务的最短通知时长
- 音频播放失败自动 fallback
- 零第三方运行时依赖

## 平台支持

### Windows / WSL

Windows 和 WSL 使用：

```text
PowerShell
  → System.Media.SoundPlayer
  → Windows Audio
```

WSL 环境会自动使用 `wslpath` 将路径转换为 Windows 路径。

### Linux

插件会自动探测系统中已有的播放器，优先级为：

```text
paplay
pw-play
aplay
ffplay
```

插件不会自动安装任何播放器。

### Fallback

WAV 无法播放时，如果存在可用 TTY，则自动 fallback 到终端 BEL：

```text
\a
```

音频播放失败不会导致 DSH 崩溃。

## 安装

插件已发布到 **npm**（包名 `dsh-notify-bell`）。它遵循官方 DSH 插件规范
（见 [插件教程](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)）：
声明了 `dsh.bundle` 的 Cordis bundle，自带 `cordis.patch.yml`，
导出 `Config` schema，使用官方 CLI 安装：

```bash
dsh plugin --profile web add dsh-notify-bell
```

`dsh plugin add` 会安装包并把它追加到 profile 的
`dsh.profile.bundles`，下次启动时自动应用 bundle 层，无需手动修改
patch 文件。

### 从源码 / GitHub 安装

在仓库检出目录中：

```bash
dsh plugin --profile web add ./dsh-notify-bell
```

也可以直接从 GitHub 安装（安装的是源码，建议固定 commit 以保证供应链安全）：

```bash
dsh plugin --profile web add github:zyar-er/dsh-notify-bell#<commit-sha>
```

## 配置

插件导出 Schemastery `Config` schema：Cordis 在加载时校验插件行的
`config` 并填充默认值，非法配置会直接加载失败（fail loudly），
而不是被静默忽略。

### 通过 profile patch 配置（推荐）

在 profile 的 `cordis.patch.yml`（或你自己的 `--patch` 覆盖层）中为
插件行添加 `config`：

```yaml
- id: notify-bell
  config:
    minDuration: 10
    soundPack: wav
    events:
      complete:
        sound: done
      block:
        sound: block
```

### 通过 legacy 配置文件

插件同时读取 `~/.config/dsh/notify-bell.json`（可用环境变量
`DSH_NOTIFY_BELL_CONFIG` 覆盖路径）。该文件是运行时状态层：Web 铃铛
开关把 `enabled` 持久化到这里，也保证旧部署继续可用。合并优先级：

```text
cordis.yml 显式配置  >  notify-bell.json  >  schema 默认值
```

示例文件：

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
  "wav": {
    "directory": "~/.config/dsh/notify-bell/sounds",
    "fallback": "bell"
  }
}
```

### 完成任务的最短时长

默认情况下，运行时间短于 `minDuration` 的任务只记录日志，不播放完成声音。

审批和提问不受该限制，因为这两种状态意味着 Agent 正在等待用户处理。

### 运行时静音

DSH Web 中的通知按钮可以实时开启或关闭通知。

关闭后：

- 所有通知声音都会静音
- DSH Agent 正常运行
- 其他配置保持不变
- 不需要重启 DSH

## Web UI

插件会在右上角 **Session log** 按钮旁增加通知开关：

```text
Session log   🔔
```

开启：

```text
bell
```

静音：

```text
bell-slash
```

图标会自动适配浅色和深色主题。

## 事件说明

### 完成

监听：

```text
goal/changed
operation = complete
```

短于 `minDuration` 的任务只输出日志，不播放声音。

### 审批

监听持久化事件：

```text
approval/asked
```

表示某个工具操作正在等待用户批准。

用户完成批准或拒绝后：

```text
approval/decided
```

不会再次通知。

### 提问

监听持久化 session event：

```text
tool/call
name = ask_user_question
```

表示 Agent 明确向用户提问并等待回答。

用户回答后不会再次通知。

普通 Assistant 文本中出现问号不会触发此通知。

### 受阻

监听：

```text
goal/changed
operation = block
```

表示当前目标无法继续。

### 错误

监听 DSH Agent loop：

```text
agent/error
```

这里表示 Agent 层面的错误，而不是普通 shell 命令返回非零退出码。

## 声音架构

通知使用语义化声音名称：

```text
done
permission
question
block
error
```

事件层不关心声音具体如何播放。

当前结构：

```text
semantic sound
      ↓
   soundPack
      ├── wav
      │    ├── Windows / WSL
      │    └── Linux
      │
      └── bell fallback
```

因此未来可以在不修改 DSH 事件处理逻辑的情况下增加新的音频后端。

## 测试

当前测试：

**85/85 通过**

已经完成真实验证：

- 任务完成
- 审批请求
- 用户提问
- Web UI 静音/开启
- WSL → Windows WAV 播放

错误通知路径由自动化测试覆盖，不需要通过故意破坏 API credentials 来验证。

## Developer Preview

DSH 目前仍处于 Developer Preview 阶段，其插件与事件 API 未来可能发生变化。

本插件不会修改 DSH 核心代码，而是使用当前已有的插件与事件接口。

欢迎社区重点测试：

- Windows 原生
- WSL
- Linux 音频播放
- 审批通知
- 提问通知
- 声音音量与长期使用体验
- 配置兼容性
- DSH 上游 API 变化

提交 Issue 时，请尽可能附上：

- DSH 版本
- 操作系统 / WSL 环境
- 触发的通知类型
- 实际行为
- 日志
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