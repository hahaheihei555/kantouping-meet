/**
 * 麦克风「用户意图」的极简共享状态（2026-11-07）。
 *
 * 为什么需要单独一个模块：
 * SDK 在系统音频设备变化、短暂拔出、或默认设备切换失败时，会把正在发布的
 * 麦克风轨道静音（内部是 `handleTrackEnded` → 重开默认设备失败 → `track.mute()`）。
 * 界面上表现为「麦克风图标明明是开着的，队友却听不见」——实测抓到过持续 40 秒。
 *
 * 想自动救回来，就必须区分两种「没在发」：
 *   · 用户想开（intent = true），但轨道被静音了  → 应该自动重开
 *   · 用户自己关掉（intent = false）             → 绝不能自作聪明打开
 * 所以这里只存一个布尔值，由麦克风按钮写、由 <MicWatchdog> 读。
 */

let intent = true;

export function setMicIntent(v: boolean): void {
  intent = v;
}

export function getMicIntent(): boolean {
  return intent;
}
