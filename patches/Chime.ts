'use client';

/**
 * 界面提示音（2026-11-07）。
 *
 * 为什么不用音频文件：一个 1 秒的 wav 也要几十 KB，还要处理打包路径；
 * 用 Web Audio 现场合成两个正弦音就够了，零体积、零版权问题。
 *
 * 音量刻意做得很小（峰值 0.05），并且用指数包络，避免"叮"得吓人。
 * 浏览器要求 AudioContext 必须在用户手势之后才能出声 —— 进房时点过「Join Room」，
 * 所以天然满足；桌面壳还额外开了 autoplay-policy，更没有限制。
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 一个带包络的正弦音，frequency 单位 Hz，at/dur 单位毫秒（相对"现在"） */
function tone(frequency: number, at: number, dur: number, peak = 0.05) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + at / 1000;
  const t1 = t0 + dur / 1000;

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, t0);

  const gain = ac.createGain();
  // 5ms 起音、指数衰减，听起来像"叮"而不是"哔"
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t1);

  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t1 + 0.02);
}

/** 有人进房：两个上行音（听起来是"来了"） */
export function playJoinSound(): void {
  tone(880, 0, 90);
  tone(1174, 95, 120);
}
