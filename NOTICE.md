# Third-Party Notices

This repository distributes third-party sound and icon assets alongside its
own MIT-licensed code. Their copyrights remain with their respective authors.

## react-sounds

The notification sound assets bundled with dsh-notify-bell
(`sound-showcase/sounds/*.wav`, the WAV sound pack shipped in the npm
package) are derived from
[react-sounds](https://github.com/e3ntity/react-sounds).

The plugin plays these files from the directory set by the `wav.directory`
config (default `~/.config/dsh/notify-bell/sounds`); it does not install
them there automatically — missing files fall back to the terminal BEL.

react-sounds is licensed under the MIT License.

The following sound assets are used:

- `ui/success_bling` → `done.wav`
- `notification/notification` → `permission.wav`
- `notification/info` → `question.wav`
- `ui/blocked` → `block.wav`
- `notification/error` → `error.wav`

Copyright © Lukas Schneider.

See the react-sounds repository for the full license text:
https://github.com/e3ntity/react-sounds

## Phosphor Icons

The Web UI button and the showcase site use icons from
[Phosphor Icons](https://phosphoricons.com/), including `bell` and
`bell-slash` (regular weight, SVG assets from `@phosphor-icons/core`).

Phosphor Icons is licensed under the MIT License.

Copyright © 2023 Phosphor Icons.

See:
https://github.com/phosphor-icons/core/blob/main/LICENSE
