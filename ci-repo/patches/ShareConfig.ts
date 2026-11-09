/**
 * 投屏发布参数的唯一来源。
 *
 * 为什么单独一个文件：同一个"码率上限"要在三处被读到 ——
 *   1. <PageClientImpl> 构造 Room 时的 publishDefaults（决定发布时的编码参数）
 *   2. <ScreenQuality> 面板（共享进行中用 sender.setParameters 实时改）
 *   3. <RoomLayout> 点开始共享时（决定采集端的 contentHint）
 * 三处各写一份常量，迟早出现"面板显示 2.4M、实际在发 1.6M"。
 *
 * 2026-11-07：码率改成**全自动**，用户不再手动选档。
 *   - 起步 2.4 Mbps
 *   - 丢包 > 5% 或编码器报"带宽受限" 连续 3 秒 → 降一档（2.4 → 1.6 → 1.0）
 *   - 走 TCP（跨境拥塞时服务端会回退）→ **直接压到 1.0**，因为 TCP 拥塞控制下
 *     高码率只会把队头阻塞放大（实测 2.4M 目标在 TCP 下掉到 469 kbps / 5fps）
 *   - 恢复干净（丢包 < 1% 且无带宽限制）连续 15 秒 → 升一档回去
 */

/** 采集端锁死 720p30。编码器输入直接是 720p，省掉 1080p→720p 的缩放与一半编码开销。 */
export const CAPTURE_W = 1280;
export const CAPTURE_H = 720;
export const CAPTURE_FPS = 30;

export const HINT_KEY = 'dsh-share-hint';

/**
 * 自动码率的三个档位（bit/s），升降级只在这三档之间走。
 * 参考：LiveKit `ScreenSharePresets.h720fps30` = 2.0 Mbps；
 * 官方 bitrate guide 的"游戏"内容 720p30 H.264 ≈ 3.5 Mbps（VMAF 85）。
 * 这条链路实测观众侧约 2.3 Mbps，晚高峰会掉到 0.5–1.5 Mbps，所以需要 1.0M 兜底。
 */
export const RATE_TIERS: number[] = [1_000_000, 1_600_000, 2_400_000];

/** 自动模式的起步值（也是上限） */
export const AUTO_BASE = 2_400_000;

/** 走 TCP 时直接压到这一档 */
export const TCP_RATE = 1_000_000;

/** 丢包率超过这个值视为"网络差"（0-1） */
export const LOSS_BAD = 0.05;
/** 丢包率低于这个值视为"网络干净"（0-1） */
export const LOSS_GOOD = 0.01;
/** 连续多少个采样（秒）判为差 → 降档 */
export const BAD_TICKS = 3;
/** 连续多少个采样（秒）判为好 → 升档 */
export const GOOD_TICKS = 15;

export type ShareHint = 'motion' | 'text';

/** motion = 游戏/视频（码率紧张时保帧率）；text = 文档/代码（保文字锐度） */
export function loadHint(): ShareHint {
  try {
    const raw = window.localStorage.getItem(HINT_KEY);
    if (raw === 'motion' || raw === 'text') return raw;
  } catch {
    /* ignore */
  }
  return 'motion';
}

export function saveHint(h: ShareHint): void {
  try {
    window.localStorage.setItem(HINT_KEY, h);
  } catch {
    /* ignore */
  }
}

export function mbps(v: number): string {
  return (v / 1_000_000).toFixed(1) + 'M';
}
