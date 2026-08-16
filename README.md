# dsh-notify-bell

[English](./README.md) | [中文](./README.zh.md) | [Changelog](./CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-notify-bell)](https://www.npmjs.com/package/dsh-notify-bell) [![GitHub Release](https://img.shields.io/github/v/release/ZYar-er/dsh-notify-bell)](https://github.com/ZYar-er/dsh-notify-bell/releases/latest)

A **community plugin** for DeepSeek Harness (DSH) — semantic notification sounds.

Semantic notification sounds for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> **Developer Preview · v0.12.0**

🎧 **[Listen to the notification sounds →](https://zyar-er.github.io/dsh-notify-bell/sound-showcase/)**

dsh-notify-bell lets you step away from the DSH Web UI without missing important agent events.

Instead of notifying on every internal event, it focuses on moments when the agent actually needs your attention:

- ✓ **Complete** — the task finished
- 🔐 **Approval** — a tool operation needs your approval
- ❓ **Question** — the agent is waiting for an answer
- ⚠ **Blocked** — the goal cannot continue
- ✗ **Error** — the agent encountered an error

Each event uses a distinct semantic sound rather than encoding meaning by counting beeps.

## Features

- Semantic notifications for complete, approval, question, block, and error events
- Official Cordis plugin form: exported `Config` schema (fail-loud validation) + `dsh.bundle` patch
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
- No runtime dependencies beyond the official `@deepseek-ai/schemastery`

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

Published on **npm** as `dsh-notify-bell`. The plugin follows the official
DSH plugin format (see the
[plugin tutorials](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)):
it is a Cordis bundle that declares its own `cordis.patch.yml` via
`dsh.bundle`, exports a `Config` schema, and installs with the official
CLI:

```bash
dsh plugin --profile web add dsh-notify-bell
```

`dsh plugin add` installs the package and appends it to the profile's
`dsh.profile.bundles`, so the bundle layer is applied automatically on the
next boot. No manual patch editing is required.

### From source / GitHub

From a checkout of this repository:

```bash
dsh plugin --profile web add ./dsh-notify-bell
```

Or install straight from GitHub (sources only, so pin a commit for
supply-chain safety):

```bash
dsh plugin --profile web add github:zyar-er/dsh-notify-bell#<commit-sha>
```

## Configuration

The plugin exports a Schemastery `Config` schema: Cordis validates the
`config` of the plugin row and fills defaults at load time, and invalid
values fail loudly instead of being silently ignored.

### Via the profile patch (recommended)

Add a `config` block to the plugin row in your profile's
`cordis.patch.yml` (or your own `--patch` overlay):

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

### Via the legacy config file

The plugin also reads `~/.config/dsh/notify-bell.json` (override with the
`DSH_NOTIFY_BELL_CONFIG` environment variable). This file is the
runtime-state layer: the Web UI bell toggle persists `enabled` here, and
it keeps older deployments working. Merge priority is:

```text
explicit cordis.yml config  >  notify-bell.json  >  schema defaults
```

Example file:

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

### Playback location

`playback` chooses where the notification sound is played
(`soundPack` only affects `playback: backend`; the browser always plays
the package's bundled WAV files). The default is `browser`; you can
also change it at runtime from the bell popover in the DSH Web UI (no
restart needed):

- `browser`: the backend classifies events and writes logs, but plays
  nothing locally. It pushes the semantic sound over Server-Sent
  Events (`GET /notify-bell/events`), and the DSH Web UI plays the
  matching WAV (`/notify-bell/sounds/*.wav`, served from the package's
  `sound-showcase/sounds`). One sound per notification.
- `backend`: the host plays the sound (BEL or WAV via `soundPack`);
  the browser stays silent.
- `none`: logs only — nothing is pushed to the browser and no local
  audio is played.

Browser notes:

- The browser uses Web Audio; autoplay policy requires one user
  gesture (`pointerdown`/`keydown`) before the first sound. Until then
  playback is silently refused and a locked state is recorded in the
  console (`console.debug`), never thrown.
- No `both`, no backend fallback, no multi-tab coordination yet.
- `enabled=false` still silences everything: the backend pushes
  nothing and the browser plays nothing. `enabled` and `playback` are
  independent settings.

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

A notification button (bell) is added next to **Session log**:

```text
Session log   🔔
```

Clicking the bell opens a compact notification settings popover:

- **Notifications**: an On/Off switch (enabled = `bell` icon, disabled =
  `bell-slash`).
- **Playback**: a radio group with Browser (play in the browser) /
  Backend (play on the host) / None (logs only).

Changes apply immediately and are persisted to
`~/.config/dsh/notify-bell.json` — no DSH restart needed. The icon and
popover follow the current light/dark theme.

## Event Details

### Complete

Triggered when the agent finishes its final answer to a user request — the
durable session event that the DSH Web UI itself uses to close a turn:

```text
session/event
type = turn/end
data.reason.kind = completed
```

Only main sessions notify (subagent turns with `delegationDepth >= 1` are
ignored), and the turn must actually produce a final assistant text answer:
the last `assistant/message` must contain a non-empty `text` block and no
`tool/call` may follow it. Empty no-op turns (a queued message cleared before
it was claimed) and tool-call-only/concludes-turn endings are silently ignored.
`goal/changed` with `operation = complete` no longer plays a sound.

The duration is `turn/end.time - turn/start.time`; requests shorter than
`minDuration` are logged but do not play a sound. If the plugin loads mid-turn
but still observes the final `assistant/message`, the completion is logged
without a sound; if it loads only after that final answer, the turn stays
silent because the final-answer condition cannot be verified.

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

**All tests passing** — 6 node:test cases (1 unit script with 171+ assertion checks inside + 5 session-layer integration).

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

## License

The dsh-notify-bell source code is licensed under the
[MIT License](./LICENSE).

This repository also distributes third-party sound and icon assets.
See [NOTICE.md](./NOTICE.md) for their respective licenses and attribution.