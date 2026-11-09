'use client';

/**
 * 麦克风输出增益（2026-11-09）。
 *
 * 需求：把「音量」面板里那条没用的「自己的音量」换成「我的麦克风音量」。
 *
 * 为什么不能像别人那样调：别人的音量是 `RemoteAudioTrack.setVolume()`，改的是**本机播放**；
 * 而你听不到自己的麦克风。要让队友听起来变大变小，只能在**发布链路上**插一个增益节点：
 *     mic 源 → [降噪 worklet] → GainNode → 发布出去
 * 我们的降噪处理器（DfnProcessor）本来就是一条 Web Audio 链路，增益插在那里最省事。
 *
 * 但降噪是可以被关掉的（那个开关一关就没有链路了）→ 关掉时改挂一个「只做增益」的
 * GainProcessor，保证任何时候都能调。
 */

const KEY = 'dsh-mic-gain';
const MIN = 0;
const MAX = 2; // 200%

let gain = 1;
const listeners = new Set<(g: number) => void>();

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX, Math.max(MIN, v));
}

/** 读出持久化的值并初始化（只该调用一次，通常在组件挂载时） */
export function loadMicGain(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw !== null) {
      const v = Number(raw);
      if (Number.isFinite(v)) gain = clamp(v / 100);
    }
  } catch {
    /* 隐私模式忽略 */
  }
  return gain;
}

export function getMicGain(): number {
  return gain;
}

export function setMicGain(v: number): void {
  gain = clamp(v);
  try {
    window.localStorage.setItem(KEY, String(Math.round(gain * 100)));
  } catch {
    /* 忽略 */
  }
  listeners.forEach((fn) => fn(gain));
}

/** 订阅变化，返回取消函数。处理器在 init 时订阅、destroy 时取消。 */
export function onMicGainChange(fn: (g: number) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// 模块加载即恢复上次的值：处理器 init 时会立刻读 getMicGain()，
// 这里先读出来，避免"设过 150%，重进房第一次仍是 100%"。
if (typeof window !== 'undefined') {
  loadMicGain();
}
