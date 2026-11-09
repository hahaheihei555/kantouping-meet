'use client';

import * as React from 'react';
import { useRoomContext } from '@livekit/components-react';
import { LocalAudioTrack, RoomEvent, Track } from 'livekit-client';
import { DFN_DEFAULTS, DfnProcessor } from './DfnProcessor';
import { GainProcessor } from './GainProcessor';

/**
 * 麦克风降噪面板（DeepFilterNet3）。
 *
 * 为什么从 Krisp 换成 DeepFilterNet3：
 * - Krisp 对风扇/键盘这类**持续背景噪声**很有效，但对**近嘴的呼吸、吸气、咂嘴**
 *   几乎不处理——那些声音在声学上像语音起音，通用模型不敢杀。
 * - DeepFilterNet3 自带一个**停顿门**（`pauseAttenuationDb`），说话间隙把底噪
 *   硬压到 -60dB 以下，正好治这些"间歇性身体声音"。
 * - LiveKit 一条轨道只能挂一个 TrackProcessor，所以两者二选一；DFN3 一个顶两层，
 *   且实测（用户本地 A/B）效果明显更好。
 *
 * 之前那版手写"噪声门"已删除：它靠 `MediaStreamTrack.enabled` 静音，
 * 而分析节点读的又是同一条轨道，导致门一关就再也读不到声音 → 麦克风彻底哑掉。
 * 现在的门在模型内部，增益平滑，且分析在增益之前，不存在这个自锁问题。
 */

const KEY_ON = 'dsh-dfn-on';
const KEY_PAUSE = 'dsh-dfn-pause';

const PAUSE_MIN = 45;
const PAUSE_MAX = 90;

function read(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

type Status = 'off' | 'loading' | 'ready' | 'waiting' | 'error';

export function NoiseControl() {
  const room = useRoomContext();
  const [on, setOn] = React.useState(true);
  const [pauseDb, setPauseDb] = React.useState(DFN_DEFAULTS.pauseAttenuationDb);
  const [status, setStatus] = React.useState<Status>('waiting');
  const [error, setError] = React.useState('');
  const applied = React.useRef<string>('');

  React.useEffect(() => {
    setOn(read(KEY_ON, 'on') !== 'off');
    const p = Number(read(KEY_PAUSE, String(DFN_DEFAULTS.pauseAttenuationDb)));
    if (Number.isFinite(p) && p >= PAUSE_MIN && p <= PAUSE_MAX) setPauseDb(p);
  }, []);

  /** 挂/摘处理器。依赖变化或麦克风重新打开时都会重跑。 */
  const apply = React.useCallback(async () => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) {
      setStatus('waiting');
      return;
    }
    if (!on) {
      // 【2026-11-09 改】关掉降噪 ≠ 不挂处理器。
      // 「我的麦克风音量」是靠发布链路上的增益节点实现的，链路没了滑块就失效，
      // 所以这里换成只做增益的 GainProcessor。
      const sig = `gain|${track.sid ?? track.mediaStreamTrack.id}`;
      if (applied.current !== sig) {
        try {
          await track.stopProcessor();
        } catch {
          /* 没挂过 */
        }
        try {
          await track.setProcessor(new GainProcessor());
          applied.current = sig;
        } catch (e) {
          console.warn('[降噪] 挂增益处理器失败', e);
          applied.current = '';
        }
      }
      setStatus('off');
      return;
    }

    const sig = `${track.sid ?? track.mediaStreamTrack.id}|${pauseDb}`;
    if (applied.current === sig) return;

    setStatus('loading');
    setError('');
    try {
      await track.stopProcessor().catch(() => {});
      await track.setProcessor(
        new DfnProcessor({
          speechAttenuationDb: DFN_DEFAULTS.speechAttenuationDb,
          pauseAttenuationDb: pauseDb,
          pauseGateLookaheadFrames: DFN_DEFAULTS.pauseGateLookaheadFrames,
        }),
      );
      applied.current = sig;
      setStatus('ready');
    } catch (e) {
      applied.current = '';
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [room, on, pauseDb]);

  React.useEffect(() => {
    apply();
  }, [apply]);

  React.useEffect(() => {
    const reapply = () => {
      applied.current = '';
      apply();
    };
    room.on(RoomEvent.LocalTrackPublished, reapply);
    room.on(RoomEvent.LocalTrackUnpublished, reapply);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, reapply);
      room.off(RoomEvent.LocalTrackUnpublished, reapply);
    };
  }, [room, apply]);

  const toggle = () => {
    const next = !on;
    setOn(next);
    write(KEY_ON, next ? 'on' : 'off');
  };

  const changePause = (v: number) => {
    setPauseDb(v);
    write(KEY_PAUSE, String(v));
  };

  const rowBtn: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '6px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    border: '1px solid #2c3441',
    background: 'transparent',
    color: '#c3ccd8',
    marginBottom: 6,
  };

  // 只渲染内容：容器（开合/定位/遮罩）由 <SettingsPanel> 统一负责，
  // 这样三个设置面板不会各自 fixed 定位互相压住。
  return (
    <div style={{ color: '#d7dde5', fontSize: 12 }}>
      <div style={{ marginBottom: 8, color: '#cfd6e1', fontWeight: 600 }}>麦克风降噪</div>

      <button
        onClick={toggle}
        style={{
          ...rowBtn,
          border: on ? '1px solid #2f8cff' : '1px solid #2c3441',
          background: on ? 'rgba(47,140,255,0.18)' : 'transparent',
        }}
      >
        <span>DeepFilterNet3</span>
        <strong style={{ color: on ? '#7ec4ff' : '#8f9aa8' }}>{on ? '已开' : '关'}</strong>
      </button>

      <div style={{ color: '#8f9aa8', margin: '8px 0 4px' }}>
        停顿期衰减 <b style={{ color: '#cfdae6' }}>{pauseDb} dB</b>
      </div>
      <input
        type="range"
        min={PAUSE_MIN}
        max={PAUSE_MAX}
        step={5}
        value={pauseDb}
        disabled={!on}
        onChange={(e) => changePause(Number(e.target.value))}
        style={{ width: '100%' }}
      />

      {/* 只在有动作/出问题时显示状态，正常时不显示任何文字 */}
      {(status === 'loading' || status === 'error') && (
        <div style={{ borderTop: '1px solid #262d38', marginTop: 10, paddingTop: 8, color: '#7f8b9a' }}>
          {status === 'loading' && '⏳ 加载中'}
          {status === 'error' && `❌ ${error}`}
        </div>
      )}
    </div>
  );
}