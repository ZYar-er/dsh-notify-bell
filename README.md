# dsh-notify-bell

[English](./README.md) | [中文](./README.zh.md)

Semantic notification sounds for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> **Developer Preview · v0.9.0**

dsh-notify-bell lets you step away from the DSH Web UI without missing important agent events.

Instead of notifying on every internal event, it focuses on moments when the agent actually needs your attention:

- ✓ **Complete** — the task finished
- 🔐 **Approval** — a tool operation needs your approval
- ❓ **Question** — the agent is waiting for an answer
- ⚠ **Blocked** — the goal cannot continue
- ✗ **Error** — the agent encountered an error

Each event uses a distinct semantic sound rather than encoding meaning by counting beeps.

## Sound Preview

🎧 **[Listen to all notification sounds](https://zyar-er.github.io/dsh-notify-bell/sound-showcase/)**

| Event | Sound | Source | Duration |
|---|---|---|---:|
| Complete | `ui/success_bling` | react-sounds | 0.76s |
| Approval | `notification/notification` | react-sounds | 0.86s |
| Question | `notification/info` | react-sounds | 0.86s |
| Blocked | `ui/blocked` | react-sounds | 0.89s |
| Error | `notification/error` | react-sounds | 0.55s |

The audio files are bundled locally with the plugin. The plugin does not depend on the react-sounds runtime or CDN.

## Features

- Semantic notifications for complete, approval, question, block, and error events
- WAV sound pack
- BEL fallback
- Native Windows audio support
- WSL → Windows audio support
- Native Linux audio support
- Runtime mute/unmute from the DSH Web UI
- Light/dark theme support
- Phosphor `bell` / `bell-slash` notification button
- Configurable event sounds
- Configurable minimum duration for completion notifications
- Automatic fallback when audio playback is unavailable
- Zero third-party runtime dependencies

## Platform Support

### Windows / WSL

On Windows and WSL, WAV playback uses:

```text
PowerShell
  → System.Media.SoundPlayer
  → Windows Audio
```

WSL paths are converted automatically with `wslpath`.

### Linux

The plugin automatically probes available audio players in this order:

```text
paplay
pw-play
aplay
ffplay
```

No additional player is installed by the plugin.

### Fallback

When WAV playback is unavailable, the plugin falls back to the terminal BEL (`\a`) when a TTY is available.

Audio playback failures never crash DSH.

## Installation

Install the plugin into the DSH Web profile:

```bash
dsh plugin --profile web add <plugin-package>
```

Enable it in your Web profile configuration.

The exact installation command may vary depending on how the package is published.

## Configuration

Configuration file:

```text
~/.config/dsh/notify-bell.json
```

Example:

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

### Completion threshold

Tasks shorter than `minDuration` do not play a completion sound.

Approval and question notifications are immediate because they indicate that the agent is waiting for the user.

### Runtime mute

The notification button in the DSH Web UI can enable or disable notifications instantly.

When disabled:

- all notification sounds are muted
- DSH itself continues running normally
- the current configuration is preserved
- no restart is required

## Web UI

A notification button is added next to **Session log**:

```text
Session log   🔔
```

When enabled:

```text
bell
```

When muted:

```text
bell-slash
```

The icon follows the current light/dark theme.

## Event Details

### Complete

Triggered when a DSH goal reaches:

```text
goal/changed
operation = complete
```

Short tasks below `minDuration` are logged but do not play a sound.

### Approval

Triggered by the durable:

```text
approval/asked
```

This represents a tool operation waiting for user approval.

`approval/decided` does not generate another notification.

### Question

Triggered by the durable session event:

```text
tool/call
name = ask_user_question
```

This represents the agent explicitly asking the user a question.

The response does not generate another notification.

### Block

Triggered when a goal enters:

```text
goal/changed
operation = block
```

### Error

Triggered by the DSH agent loop's:

```text
agent/error
```

This represents an agent-level error, not an ordinary command returning a non-zero exit code.

## Sound Architecture

Notifications are represented by semantic sound names:

```text
done
permission
question
block
error
```

The event layer does not know how a sound is physically played.

Current backends:

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

This makes it possible to add other backends later without changing the DSH event handling.

## Testing

Current test suite:

**79/79 tests passing**

Real-world verification has been completed for:

- task completion
- approval requests
- user questions
- Web UI mute/unmute
- WSL → Windows WAV playback

The error notification path is covered by tests; deliberately breaking credentials is not required for normal validation.

## Developer Preview

DSH is still in developer preview, so its plugin and event APIs may change.

This plugin intentionally avoids modifying the DSH core and relies on currently available plugin/event interfaces.

Community testing is especially welcome for:

- Windows native
- WSL
- Linux audio playback
- approval notifications
- question notifications
- sound loudness and comfort
- configuration compatibility
- DSH upstream changes

Please include your DSH version, OS/environment, relevant event, and reproduction steps when reporting an issue.

## Credits

Sound assets are from [react-sounds](https://github.com/e3ntity/react-sounds).

Icons use [Phosphor Icons](https://phosphoricons.com/).

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).