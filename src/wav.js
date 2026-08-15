/**
 * dsh-notify-bell — WAV sound pack 入口（v7）。
 *
 * 薄封装：把平台感知的音频后端（audio.js）以 v6 兼容的
 * `createWavBackend` 名字暴露给插件组装层。事件层不感知平台。
 *
 * 平台支持：
 *   - WSL / Windows → powershell.exe + System.Media.SoundPlayer
 *   - Linux → paplay / pw-play / aplay / ffplay（探测优先级）
 *   - 其他 → 直接 fallback BEL
 * 所有播放失败路径自动 fallback 到 BEL（bell.js），不抛异常。
 */
export { createAudioBackend as createWavBackend, SOUND_FILES, detectPlatform, detectWindowsPlayer, detectLinuxPlayer, detectPlayerFor } from './audio.js';
