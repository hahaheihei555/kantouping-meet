'use client';

import * as React from 'react';
import { useRoomContext, useTrackVolume, useTracks } from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { RemoteAudioTrack, Track } from 'livekit-client';
import { getMicGain, setMicGain } from './MicGain';
import { MIC_KEY, deviceExists, forgetSavedMic } from './MicDevice';

/**
 * 音量面板。
 *
 * 结构（2026-11-09 改版）：
 *   1. 总音量      —— 一次调所有人，0–200%，是乘数（实际 = 单人值 × 总音量）
 *   2. 我的麦克风  —— 调「自己输出给别人的音量」，走发布链路上的增益节点（见 MicGain.ts）
 *   3. 单人列表    —— 每个人的人声 / 伴音
 *
 * 为什么第 2 项不是「自己的播放音量」：你听不到自己的麦克风，
 * 那条滑块原来调的是本机播放，纯摆设。改成输出增益才有意义。
 *
 * 实现上刻意复用 SDK 的能力，不自己造轮子：
 * - 电平显示：官方 hook `useTrackVolume`
 * - 对方音量：`RemoteAudioTrack.setVolume()`（官方 AudioTrack 内部也是它）
 * - 自己音量：发布链路的 GainNode（DfnProcessor / GainProcessor）
 */

const STORAGE_KEY = 'dsh-audio-mixer-volumes';
const MASTER_KEY = 'dsh-master-volume';

const SOURCE_LABEL: Record<string, string> = {
  microphone: '人声',
  screen_share_audio: '伴音',
};

const SOURCE_ICON: Record<string, string> = {
  microphone: '🎙',
  screen_share_audio: '🎮',
};

type VolMap = Record<string, number>;

function keyOf(who: string, source: string): string {
  return `${who}|${source}`;
}

/** 单行：标签 + 电平条 + 滑杆。电平用官方 useTrackVolume。 */
function MixerRow(props: {
  trackRef: TrackReference;
  value: number;
  onChange: (v: number) => void;
}) {
  const level = useTrackVolume(props.trackRef);
  const pct = Math.min(100, Math.round(level * 400));
  const source = String(props.trackRef.publication?.source ?? '');
  const who = props.trackRef.participant.name || props.trackRef.participant.identity;

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 3,
          color: '#a9b3c1',
        }}
      >
        <span>
          {SOURCE_ICON[source] ?? '🔈'} {SOURCE_LABEL[source] ?? source}
          <span style={{ color: '#5f6b7a' }}> · {who}</span>
        </span>
        <span style={{ color: props.value === 0 ? '#e06c6c' : '#7fd1a8' }}>{props.value}%</span>
      </div>

      {/* 电平条：有声音才会亮，能一眼看出对方到底在不在说话 */}
      <div
        style={{
          height: 3,
          background: '#232833',
          borderRadius: 2,
          marginBottom: 5,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: pct + '%',
            height: '100%',
            background: pct > 60 ? '#e0b04a' : '#3aa76d',
            transition: 'width 80ms linear',
          }}
        />
      </div>

      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={props.value}
        onChange={(ev) => props.onChange(Number(ev.target.value))}
        style={{ width: '100%', accentColor: '#2d6ae0' }}
      />
    </div>
  );
}

/** 只调一个值的行（总音量 / 我的麦克风），没有电平条 */
function SimpleRow(props: {
  icon: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 3,
          color: '#a9b3c1',
        }}
      >
        <span>
          {props.icon} {props.label}
        </span>
        <span style={{ color: props.value === 0 ? '#e06c6c' : '#7fd1a8' }}>{props.value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={props.value}
        onChange={(ev) => props.onChange(Number(ev.target.value))}
        style={{ width: '100%', accentColor: '#2d6ae0' }}
      />
    </div>
  );
}

export function AudioMixer() {
  const room = useRoomContext();
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio], {
    onlySubscribed: true,
  });

  const [vols, setVols] = React.useState<VolMap>({});
  const [master, setMaster] = React.useState(100);
  const [myGain, setMyGain] = React.useState(100);

  /* ---------------- 输入设备（麦克风）选择，2026-11-13 ---------------- */
  const [inputs, setInputs] = React.useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = React.useState('');
  const [micErr, setMicErr] = React.useState('');

  /** 枚举输入设备；没拿到权限时 label 是空的，用"麦克风 N"占位 */
  const refreshInputs = React.useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setInputs(all.filter((d) => d.kind === 'audioinput'));
    } catch {
      /* 浏览器不支持 / 权限被拒 */
    }
  }, []);

  React.useEffect(() => {
    // 记住的设备要是不在了（耳机拔了/换了电脑），顺手清掉，
    // 否则下次进房还会拿它去开麦（见 MicDevice.ts）
    void (async () => {
      const saved = window.localStorage.getItem(MIC_KEY) ?? '';
      if (saved && !(await deviceExists('audioinput', saved))) forgetSavedMic();
    })();
    void refreshInputs();
    // 插拔 USB 麦克风/耳机时列表要跟着变
    const onChange = () => void refreshInputs();
    navigator.mediaDevices?.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', onChange);
  }, [refreshInputs]);

  // 初始值：优先读当前麦克风轨道的真实 deviceId，其次读记住的选择
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MIC_KEY) ?? '';
      const t = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      const now = t?.mediaStreamTrack.getSettings().deviceId;
      setMicId(now || saved);
    } catch {
      /* 忽略 */
    }
  }, [room]);

  const switchMic = async (deviceId: string) => {
    setMicErr('');
    setMicId(deviceId);
    try {
      window.localStorage.setItem(MIC_KEY, deviceId);
    } catch {
      /* 忽略 */
    }
    try {
      // 选「系统默认」时 deviceId 是空串，这时不能要求 exact（会报错）；
      // 指定具体设备时用 exact=true：设备拔掉了就报错，别静默切回默认设备
      await room.switchActiveDevice('audioinput', deviceId, !!deviceId);
    } catch (e) {
      setMicErr('切换失败，可能设备已被拔掉');
      console.warn('[mic] 切换输入设备失败', e);
      void refreshInputs();
    }
  };

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setVols(JSON.parse(raw) as VolMap);
      const m = window.localStorage.getItem(MASTER_KEY);
      if (m !== null) {
        const v = Number(m);
        if (Number.isFinite(v)) setMaster(Math.min(200, Math.max(0, v)));
      }
    } catch {
      /* 忽略 */
    }
    setMyGain(Math.round(getMicGain() * 100));
  }, []);

  const apply = React.useCallback((next: VolMap) => {
    setVols(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  }, []);

  const changeMaster = (v: number) => {
    setMaster(v);
    try {
      window.localStorage.setItem(MASTER_KEY, String(v));
    } catch {
      /* 忽略 */
    }
  };

  const changeMyGain = (v: number) => {
    setMyGain(v);
    setMicGain(v / 100);
  };

  // 把「单人值 × 总音量」作用到轨道上
  React.useEffect(() => {
    for (const ref of tracks) {
      const track = ref.publication?.track;
      if (!track || track.kind !== Track.Kind.Audio) continue;
      const key = keyOf(
        ref.participant.name || ref.participant.identity,
        String(ref.publication?.source ?? ''),
      );
      const v = vols[key];
      if (v === undefined && master === 100) continue;
      const per = v === undefined ? 100 : v;
      const effective = Math.min(200, Math.max(0, (per * master) / 100));
      try {
        (track as RemoteAudioTrack).setVolume(effective / 100);
      } catch {
        /* 轨道可能已销毁 */
      }
    }
  }, [tracks, vols, master]);

  // 自己那一行去掉（调本机播放没意义），只留别人 + 下面的「我的麦克风」
  const myIdentity = room.localParticipant?.identity;
  const rows = tracks.filter(
    (ref) =>
      ref.participant.identity !== myIdentity &&
      ref.publication?.track &&
      ref.publication.track.kind === Track.Kind.Audio,
  );

  return (
    <div style={{ color: '#e6e6e6', fontSize: 12 }}>
      <div style={{ marginBottom: 8, color: '#cfd6e1', fontWeight: 600 }}>音量</div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ color: '#a9b3c1', marginBottom: 4 }}>
          🎙 输入设备
          {micErr && <span style={{ color: '#e06c6c', marginLeft: 8 }}>{micErr}</span>}
        </div>
        <select
          value={micId}
          onChange={(e) => void switchMic(e.target.value)}
          style={{
            width: '100%',
            background: '#0f141a',
            border: '1px solid #263140',
            borderRadius: 8,
            color: '#dbe3ec',
            fontSize: 12,
            padding: '6px 8px',
          }}
        >
          <option value="">系统默认</option>
          {inputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `麦克风 ${i + 1}`}
            </option>
          ))}
        </select>
      </div>

      <SimpleRow icon="🔊" label="总音量" value={master} onChange={changeMaster} />
      <SimpleRow icon="🎙" label="我的麦克风" value={myGain} onChange={changeMyGain} />

      <div style={{ borderTop: '1px solid #262d38', margin: '2px 0 10px' }} />

      {rows.length === 0 ? (
        <div style={{ color: '#5d6875', lineHeight: 1.7, marginBottom: 4 }}>
          当前没有别人的音轨。
          <br />
          接收了投屏、或对方开麦后，这里会出现单人音量。
        </div>
      ) : (
        rows.map((ref) => {
          const source = String(ref.publication?.source ?? '');
          const key = keyOf(ref.participant.name || ref.participant.identity, source);
          return (
            <MixerRow
              key={key}
              trackRef={ref}
              value={vols[key] ?? 100}
              onChange={(v) => apply({ ...vols, [key]: v })}
            />
          );
        })
      )}
    </div>
  );
}
