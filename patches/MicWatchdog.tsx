'use client';

import * as React from 'react';
import { useRoomContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { getMicIntent } from './MicIntent';

/**
 * 麦克风看门狗（2026-11-07）。
 *
 * 解决的问题：SDK 有时会把麦克风轨道静音（设备切换/短暂断开/重开默认设备失败），
 * 而且**不会自己恢复**——实测 `haha__1oib` 静音了 41 秒，用户毫不知情。
 *
 * 判定逻辑（每 3 秒一次）：
 *   · 用户想开麦，但当前没有「已发布且未静音」的麦克风轨道 → 重新 setMicrophoneEnabled(true)
 *   · 连续失败 5 次 → 冷却 30 秒再试（避免设备真坏了时每 3 秒刷屏）
 *   · 恢复成功后短暂显示一条提示，让用户知道刚才发生过什么
 *
 * 刻意不做的事：不监听 TrackEnded 直接重开（会与 SDK 自己的重连逻辑打架），
 * 只做低频轮询兜底——代价是恢复有最多 3 秒延迟，但绝不会产生竞态。
 */
export function MicWatchdog() {
  const room = useRoomContext();
  const [recovered, setRecovered] = React.useState(false);
  const attempts = React.useRef(0);
  const lastTryAt = React.useRef(0);
  const hideTimer = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    const tick = () => {
      const lp = room.localParticipant;
      if (!lp) return;

      // 用户自己关的麦，不要去开
      if (!getMicIntent()) {
        attempts.current = 0;
        return;
      }

      const pub = lp.getTrackPublication(Track.Source.Microphone);
      const live = !!pub && !pub.isMuted && !!pub.track;
      if (live) {
        attempts.current = 0;
        return;
      }

      const now = Date.now();
      // 两次尝试至少间隔 4 秒
      if (now - lastTryAt.current < 4000) return;
      // 连错 5 次 → 冷却 30 秒
      if (attempts.current >= 5 && now - lastTryAt.current < 30000) return;
      if (attempts.current >= 5) attempts.current = 0;

      lastTryAt.current = now;
      attempts.current += 1;
      console.warn(`[mic-watchdog] 麦克风未在发布，尝试重新打开（第 ${attempts.current} 次）`);

      lp.setMicrophoneEnabled(true)
        .then(() => {
          attempts.current = 0;
          setRecovered(true);
          window.clearTimeout(hideTimer.current);
          hideTimer.current = window.setTimeout(() => setRecovered(false), 8000);
        })
        .catch((e) => {
          console.warn('[mic-watchdog] 重新打开失败', e);
        });
    };

    const id = window.setInterval(tick, 3000);
    // 首次延迟 2 秒：等 SDK 自己先完成一次正常的开麦，避免和它抢
    const first = window.setTimeout(tick, 2000);

    return () => {
      window.clearInterval(id);
      window.clearTimeout(first);
      window.clearTimeout(hideTimer.current);
    };
  }, [room]);

  return recovered ? <span className="chip warn">麦克风已自动重开</span> : null;
}
