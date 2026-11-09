'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  RoomAudioRenderer,
  useLocalParticipant,
  useRemoteParticipants,
  useRoomContext,
  useTrackVolume,
} from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import {
  ConnectionState,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  RoomEvent,
  Track,
  VideoTrack,
} from 'livekit-client';
import { SettingsPanel } from './SettingsPanel';
import { CAPTURE_FPS, CAPTURE_H, CAPTURE_W, loadHint } from './ShareConfig';
import { MicWatchdog } from './MicWatchdog';
import { setMicIntent } from './MicIntent';
import { playJoinSound } from './Chime';
import {
  CHAT_MAX_LEN,
  ChatMsg,
  copyToClipboard,
  hhmm,
  parseChat,
  sendChat,
  splitLinks,
  toPlainText,
} from './Chat';

/**
 * 自定义房间布局：投屏当主角，人放右侧紧凑列表。
 *
 * 为什么弃用 components-react 的 <VideoConference>：
 * 它的默认宫格会把**每个参会者都当成视频方块**，而我们这个房间摄像头默认关闭，
 * 于是 5 个人就是 5 个大黑框，把投屏挤压成一小块。这里按实际用法重排：
 *
 *   ┌─────────────── 顶栏：房间 / 人数 / 未接收提示 ───────────────┐
 *   │                                    │                        │
 *   │        主舞台（正在看的投屏）        │   成员紧凑列表          │
 *   │                                    │   32px 一行            │
 *   │                              [pip] │                        │
 *   └─────────────── 控制栏：麦克风/摄像头/共享/离开 ──────────────┘
 *
 * 关键点：
 * - **必须自己渲染 <RoomAudioRenderer />**。它原本在 VideoConference 里，
 *   换掉之后如果漏了，所有人都听不到声音（包括屏幕共享的系统音频）。
 * - 投屏是否接收仍然由本人手动决定（默认全部不接收），这里只负责渲染与点开。
 * - 成员行用麦克风电平（`useTrackVolume`）而不是头像：没头像也能看出谁在说话。
 */

const MUTE_KEY = 'dsh-watch'; // 仅本次会话使用，不做持久化（见 ScreenQuality 注释）

type Sharer = { participant: Participant; publication: RemoteTrackPublication };

/**
 * 每个人的「接收」状态，进房默认全关（和投屏同策略，省流量）：
 *   video = 收他的投屏画面
 *   audio = 收伴音（只在 video=true 时有意义）
 *   cam   = 收他的摄像头画面（独立开关，和投屏互不影响）
 */
type WatchState = { video: boolean; audio: boolean; cam: boolean };
const WATCH_OFF: WatchState = { video: false, audio: false, cam: false };

function collectShares(participants: Participant[]): Sharer[] {
  const out: Sharer[] = [];
  participants.forEach((p) => {
    p.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        out.push({ participant: p, publication: pub as RemoteTrackPublication });
      }
    });
  });
  return out;
}

/**
 * 轨道是否「真的还在出画面」。
 * 坑：停止投屏 / 关掉摄像头之后，旧的 track 对象可能还挂在 publication 上，
 * videoTrack 不为空但 mediaStreamTrack.readyState 已经是 'ended'，
 * 这时 <video> 会定格在最后一帧（看起来就是黑屏）。必须靠这个判断挡掉。
 */
function isLiveTrack(track: { mediaStreamTrack?: MediaStreamTrack } | null | undefined): boolean {
  const mst = track?.mediaStreamTrack;
  return !!mst && mst.readyState === 'live';
}

function nameOf(p: Participant): string {
  return p.name || p.identity;
}

/** 成员行：名字 + 麦克风状态 + 电平条 + 投屏接收/伴音/摄像头开关 */
function PersonRow(props: {
  participant: Participant;
  self: boolean;
  sharing: boolean;
  video: boolean;
  audio: boolean;
  /** 这个人的摄像头是否正在发布（决定要不要显示「📷」按钮） */
  camAvailable: boolean;
  /** 我是否在收他的摄像头画面 */
  cam: boolean;
  onReceive: () => void;
  onStop: () => void;
  onToggleAudio: () => void;
  onToggleCam: () => void;
}) {
  const {
    participant: p,
    self,
    sharing,
    video,
    audio,
    camAvailable,
    cam,
    onReceive,
    onStop,
    onToggleAudio,
    onToggleCam,
  } = props;
  const micPub = p.getTrackPublication(Track.Source.Microphone);
  const micRef: TrackReference | undefined = micPub
    ? { participant: p, publication: micPub, source: Track.Source.Microphone }
    : undefined;
  const level = useTrackVolume(micRef);
  const micOn = p.isMicrophoneEnabled;
  const talking = level > 0.02;

  return (
    <div className={'person' + (talking ? ' talking' : '')}>
      <span className="bar" />
      <span className="name">
        {nameOf(p)}
        {self && <small>（你）</small>}
        {!self && sharing && <small>正在投屏</small>}
      </span>
      <span className={'mic' + (micOn ? '' : ' off')} title={micOn ? '麦克风开' : '麦克风关'}>
        {micOn ? '🎙' : '🔇'}
      </span>
      <span className="lvl">
        <i style={{ width: Math.min(100, Math.round(level * 320)) + '%' }} />
      </span>
      {sharing && !video && (
        <button className="share" onClick={onReceive} type="button" title="接收画面和伴音">
          接收
        </button>
      )}
      {sharing && video && (
        <>
          <button className="share watching" onClick={onStop} type="button" title="停止接收投屏">
            在看
          </button>
          <button
            className={'audio' + (audio ? ' on' : '')}
            onClick={onToggleAudio}
            type="button"
            title={audio ? '关闭伴音' : '打开伴音'}
          >
            {audio ? '🔊' : '🔇'}
          </button>
        </>
      )}
      {/* 摄像头和投屏是两个**独立**开关：他开着摄像头就出现这个按钮，点开才收画面 */}
      {!self && camAvailable && (
        <button
          className={'camon' + (cam ? ' on' : '')}
          onClick={onToggleCam}
          type="button"
          title={cam ? '关闭他的摄像头画面' : '查看他的摄像头画面'}
        >
          📷
        </button>
      )}
    </div>
  );
}

export function RoomLayout() {
  const room = useRoomContext();
  const router = useRouter();
  const remotes = useRemoteParticipants();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();

  /**
   * 进房默认什么都不接收（投屏画面 / 伴音 / 摄像头），全部手动点开。
   * 仅本次会话，不写 localStorage（避免下次进房意外开始耗流量）。
   */
  const [watch, setWatch] = React.useState<Record<string, WatchState>>({});
  const watchRef = React.useRef(watch);
  watchRef.current = watch;
  const [tick, setTick] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState(false);

  /**
   * 断线重连提示（2026-11-07）。
   * 这条跨境链路会周期性抖动，SDK 自己会重连，但界面上**没有任何变化**：
   * 画面停在最后一帧、麦克风没声，人会以为软件坏了，然后去点「离开」——
   * 反而把能自动恢复的连接掐断。所以显式告诉他在重连。
   */
  const [link, setLink] = React.useState<'ok' | 'reconnecting'>('ok');

  /* ---------------- 右侧栏：成员 / 聊天 两个 tab（2026-11-09 加） ---------------- */
  const [tab, setTab] = React.useState<'people' | 'chat'>('people');
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const [msgs, setMsgs] = React.useState<ChatMsg[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [draft, setDraft] = React.useState('');
  const [toast, setToast] = React.useState('');
  const msgsRef = React.useRef<HTMLDivElement>(null);
  const composingRef = React.useRef(false);
  const connected = room.state === ConnectionState.Connected;

  const say = React.useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(''), 1400);
  }, []);

  const copy = React.useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      say(ok ? '已复制' : '复制失败，请手动选中');
    },
    [say],
  );

  /**
   * 收消息。数据通道**不会回显给发送者**，自己发的那条在 submit 里本地补上。
   * 消息只存在这个 state 里：退房/刷新组件卸载，聊天记录自然清空（需求就是这么定的）。
   */
  React.useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
      const m = parseChat(payload, participant);
      if (!m) return;
      setMsgs((prev) => [...prev.slice(-199), m]);
      if (tabRef.current !== 'chat') setUnread((n) => n + 1);
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  // 新消息 / 切到聊天 tab 时滚到底
  React.useEffect(() => {
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, tab]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || !connected) return;
    setDraft('');
    const msg = await sendChat(room, body).catch((e) => {
      console.warn('[chat] 发送失败', e);
      return null;
    });
    if (msg) setMsgs((prev) => [...prev.slice(-199), msg]);
    else say('发送失败');
  };

  const onChatKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // 中文输入法还在拼音阶段时，回车是选词不是发送，必须挡掉
    if (composingRef.current || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  /**
   * 提示音：只在**有人进房**时响一声。
   * 投屏开始不响（2026-11-07 用户要求去掉）——投屏本来画面就直接出现了，
   * 再"叮"一下纯属噪音。自己的动作当然也不响。
   */
  React.useEffect(() => {
    const onJoin = () => playJoinSound();
    room.on(RoomEvent.ParticipantConnected, onJoin);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
    };
  }, [room]);

  React.useEffect(() => {
    const onReconnect = () => setLink('reconnecting');
    const onBack = () => setLink('ok');
    room.on(RoomEvent.Reconnecting, onReconnect);
    room.on(RoomEvent.SignalReconnecting, onReconnect);
    room.on(RoomEvent.Reconnected, onBack);
    return () => {
      room.off(RoomEvent.Reconnecting, onReconnect);
      room.off(RoomEvent.SignalReconnecting, onReconnect);
      room.off(RoomEvent.Reconnected, onBack);
    };
  }, [room]);

  const stateOf = React.useCallback((id: string): WatchState => watchRef.current[id] ?? WATCH_OFF, []);

  /** 某条轨道该不该订阅：投屏看 video、伴音要 video&&audio、摄像头看 cam */
  const wantFor = React.useCallback(
    (identity: string, source: Track.Source) => {
      const s = stateOf(identity);
      if (source === Track.Source.ScreenShare) return s.video;
      if (source === Track.Source.ScreenShareAudio) return s.video && s.audio;
      if (source === Track.Source.Camera) return s.cam;
      return true;
    },
    [stateOf],
  );

  React.useEffect(() => {
    const bump = () => setTick((v) => v + 1);
    const events = [
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ActiveSpeakersChanged,
      // 本地开/关投屏、开关摄像头不会触发上面那些 Remote* 事件。
      // 缺这几个的后果：自己停止共享后 tick 不更新，主舞台残留一个黑框（2026-11-09 修）。
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ];
    events.forEach((e) => room.on(e, bump));

    // B+ 方案：autoSubscribe 保持 true（保证别人麦克风一定有声），
    // 但投屏画面/伴音/摄像头在 **TrackPublished 阶段**就按当前状态退订，
    // 把“进房先听到投屏声、画面却没有”的窗口压到最小。
    const onPublished = (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const src = pub.source;
      if (
        src !== Track.Source.ScreenShare &&
        src !== Track.Source.ScreenShareAudio &&
        src !== Track.Source.Camera
      ) {
        return;
      }
      const want = wantFor(participant.identity, src);
      if (pub.isSubscribed !== want) pub.setSubscribed(want);
    };
    room.on(RoomEvent.TrackPublished, onPublished);
    return () => {
      events.forEach((e) => room.off(e, bump));
      room.off(RoomEvent.TrackPublished, onPublished);
    };
  }, [room, wantFor]);

  const allParticipants = React.useMemo<Participant[]>(
    () => [localParticipant, ...remotes],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [localParticipant, remotes, tick],
  );

  const sharers = React.useMemo<Sharer[]>(
    () => collectShares(remotes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remotes, tick],
  );

  // 把订阅状态整体对齐（覆盖：进房、有人后开投屏、重连、开关切换）
  React.useEffect(() => {
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        const src = pub.source;
        if (
          src !== Track.Source.ScreenShare &&
          src !== Track.Source.ScreenShareAudio &&
          src !== Track.Source.Camera
        ) {
          return;
        }
        const want = wantFor(p.identity, src);
        if (pub.isSubscribed !== want) (pub as RemoteTrackPublication).setSubscribed(want);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, watch, tick, wantFor]);

  const st = (id: string): WatchState => watch[id] ?? WATCH_OFF;
  /**
   * 主舞台要渲染的投屏：我点了接收 + 轨道还活着。
   * 第 2 条是 2026-11-09 加的：停止共享后旧 track 可能仍挂在 publication 上，
   * 但 mediaStreamTrack.readyState 已经是 'ended'，<video> 就定格成黑屏。
   * 注意别顺手加 isMuted 判断：暂停共享时 track 会 mute，加进去会闪空状态。
   */
  const watched = sharers.filter(
    (s) => st(s.participant.identity).video && isLiveTrack(s.publication.videoTrack),
  );

  /**
   * 要显示的摄像头画面：
   *   - 自己：只要开了摄像头就显示（否则打开摄像头看不到自己，很怪）
   *   - 别人：必须手动点「📷」才订阅显示（默认不收，省流量）
   * 没订阅时 `publication.videoTrack` 是 undefined，天然过滤掉了。
   */
  const cameras = React.useMemo(() => {
    const out: Array<{ participant: Participant; track: VideoTrack }> = [];
    allParticipants.forEach((p) => {
      const self = p.identity === localParticipant.identity;
      if (!self && !(watch[p.identity]?.cam ?? false)) return;
      const track = p.getTrackPublication(Track.Source.Camera)?.videoTrack;
      // 关掉摄像头后 publication 可能还在、track 却已 ended，别把黑框留下
      if (!track || !isLiveTrack(track)) return;
      out.push({ participant: p, track });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParticipants, watch, tick, localParticipant]);

  /** 接收投屏：画面 + 伴音一起开（不动摄像头开关） */
  const receive = (identity: string) =>
    setWatch((prev) => {
      const cur = prev[identity] ?? WATCH_OFF;
      return { ...prev, [identity]: { ...cur, video: true, audio: true } };
    });
  /** 停止接收投屏：画面 + 伴音一起关（不动摄像头开关） */
  const stopWatch = (identity: string) =>
    setWatch((prev) => {
      const cur = prev[identity] ?? WATCH_OFF;
      return { ...prev, [identity]: { ...cur, video: false, audio: false } };
    });
  /** 只切伴音，不影响画面 */
  const toggleAudio = (identity: string) =>
    setWatch((prev) => {
      const cur = prev[identity] ?? { ...WATCH_OFF, video: true, audio: true };
      return { ...prev, [identity]: { ...cur, audio: !cur.audio } };
    });
  /** 只切摄像头画面，不影响投屏 */
  const toggleCam = (identity: string) =>
    setWatch((prev) => {
      const cur = prev[identity] ?? WATCH_OFF;
      return { ...prev, [identity]: { ...cur, cam: !cur.cam } };
    });

  const leave = () => {
    room.disconnect();
    router.push('/');
  };

  const stageClass = watched.length >= 2 ? 'stage grid' : 'stage';

  return (
    <div className={'dsh-room' + (collapsed ? ' collapsed' : '') + (tab === 'chat' ? ' chatopen' : '')}>
      <RoomAudioRenderer />

      <header className="top">
        <span className="room">{room.name}</span>
        <span className="chip">{allParticipants.length} 人在线</span>
        {sharers.length > 0 && watched.length === 0 && (
          <span className="chip warn">{sharers.length} 人在投屏 · 你未接收</span>
        )}
        {link !== 'ok' && <span className="chip warn">重连中…</span>}
        <MicWatchdog />
        <span className="spacer" />
        <button
          className="mini"
          onClick={() => {
            // 收起后侧栏只剩 64px，聊天面板放不下，先退回成员 tab
            if (!collapsed && tab === 'chat') setTab('people');
            setCollapsed((v) => !v);
          }}
          type="button"
        >
          {collapsed ? '展开成员' : '收起成员'}
        </button>
      </header>

      <main className={stageClass}>
        {/* 重连遮罩：画面会停住，必须解释一句，否则用户以为挂了 */}
        {link !== 'ok' && (
          <div className="reconn">
            <b>连接中断，正在重连…</b>
            <span>画面会停住，恢复后自动继续，不用退出</span>
          </div>
        )}
        {/* 没有在看投屏：有摄像头就铺满主舞台 */}
        {watched.length === 0 && cameras.length > 0 && (
          <div className={'camgrid c' + Math.min(cameras.length, 6)}>
            {cameras.slice(0, 6).map((c) => (
              <div className="camcell" key={c.participant.identity}>
                <CamVideo
                  track={c.track}
                  mirrored={c.participant.identity === localParticipant.identity}
                />
                <span className="camname">{nameOf(c.participant)}</span>
              </div>
            ))}
          </div>
        )}

        {watched.length === 0 && cameras.length === 0 && (
          <div className="empty">
            <h3>{sharers.length ? '你没有接收任何投屏' : '当前没有人在投屏'}</h3>
            <p>
              {sharers.length
                ? '点右侧「接收」播放画面和伴音'
                : '想投屏就点底部「共享」'}
            </p>
            {sharers.length > 0 && (
              <div className="cta">
                {sharers.map((s) => (
                  <button
                    key={s.participant.identity}
                    className="primary"
                    onClick={() => receive(s.participant.identity)}
                    type="button"
                  >
                    接收 {nameOf(s.participant)} 的投屏
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {watched.map((s) => {
          const ref: TrackReference = {
            participant: s.participant,
            publication: s.publication,
            source: Track.Source.ScreenShare,
          };
          return (
            <div className="screen" key={s.participant.identity}>
              <SharedVideo trackRef={ref} />
              <div className="badge">
                <b>{nameOf(s.participant)}</b> 正在投屏
              </div>
              <div className="stagebtns">
                <button
                  className={'audio' + (st(s.participant.identity).audio ? ' on' : '')}
                  onClick={() => toggleAudio(s.participant.identity)}
                  type="button"
                  title={st(s.participant.identity).audio ? '关闭伴音' : '打开伴音'}
                >
                  {st(s.participant.identity).audio ? '🔊 伴音' : '🔇 伴音'}
                </button>
                <button
                  className="stopwatch"
                  onClick={() => stopWatch(s.participant.identity)}
                  type="button"
                >
                  停止接收
                </button>
              </div>
            </div>
          );
        })}

        {/* 投屏 + 摄像头同时存在：摄像头缩成右下角画中画（最多 4 个） */}
        {watched.length > 0 && cameras.length > 0 && (
          <div className="campip">
            {cameras.slice(0, 4).map((c) => (
              <div className="camcell" key={c.participant.identity}>
                <CamVideo
                  track={c.track}
                  mirrored={c.participant.identity === localParticipant.identity}
                />
                <span className="camname">{nameOf(c.participant)}</span>
              </div>
            ))}
          </div>
        )}

      </main>

      <aside className={'people' + (collapsed ? ' collapsed' : '')}>
        <div className="ptabs">
          <button
            className={'ptab' + (tab === 'people' ? ' on' : '')}
            onClick={() => setTab('people')}
            type="button"
            title="成员列表"
          >
            <span>👥</span>
            <span className="ptabtxt">成员 {allParticipants.length}</span>
          </button>
          <button
            className={'ptab' + (tab === 'chat' ? ' on' : '')}
            onClick={() => {
              setTab('chat');
              setUnread(0);
              if (collapsed) setCollapsed(false);
            }}
            type="button"
            title="聊天"
          >
            <span>💬</span>
            <span className="ptabtxt">聊天</span>
            {unread > 0 && <i className="pdot">{unread > 99 ? '99+' : unread}</i>}
          </button>
        </div>

        {tab === 'people' ? (
          <div className="list">
            {allParticipants.map((p) => (
              <PersonRow
                key={p.identity}
                participant={p}
                self={p.identity === localParticipant.identity}
                sharing={sharers.some((s) => s.participant.identity === p.identity)}
                video={st(p.identity).video}
                audio={st(p.identity).audio}
                camAvailable={!!p.getTrackPublication(Track.Source.Camera)}
                cam={st(p.identity).cam}
                onReceive={() => receive(p.identity)}
                onStop={() => stopWatch(p.identity)}
                onToggleAudio={() => toggleAudio(p.identity)}
                onToggleCam={() => toggleCam(p.identity)}
              />
            ))}
          </div>
        ) : (
          <div className="chat">
            <div className="chatbar">
              <span className="dim">
                {msgs.length ? `${msgs.length} 条消息` : '仅本次房间可见'}
              </span>
              <button
                className="mini"
                onClick={() => {
                  if (msgs.length) void copy(toPlainText(msgs));
                }}
                type="button"
                disabled={!msgs.length}
              >
                复制全部
              </button>
            </div>

            <div className="msgs" ref={msgsRef}>
              {msgs.length === 0 && (
                <div className="chempty">
                  还没有消息
                  <span>离开房间后自动清空</span>
                </div>
              )}
              {msgs.map((m, i) => {
                const prev = msgs[i - 1];
                // 同一人连续说话不重复显示名字；间隔超过 5 分钟再显示一次
                const showHead = !prev || prev.from !== m.from || m.ts - prev.ts > 300000;
                return (
                  <div className={'msg' + (m.self ? ' mine' : '')} key={m.id}>
                    {showHead && (
                      <div className="mhead">
                        <span className="mname">{m.name}</span>
                        <span className="mtime">{hhmm(m.ts)}</span>
                      </div>
                    )}
                    <div className="mbody">
                      <span className="mtext">
                        {splitLinks(m.text).map((seg, k) =>
                          seg.url ? (
                            <a
                              key={k}
                              href={seg.s}
                              onClick={(e) => {
                                // 不跳转：Electron 壳没配 openExternal，点了会开一个空白窗
                                e.preventDefault();
                                void copy(seg.s);
                              }}
                              title="点击复制链接"
                            >
                              {seg.s}
                            </a>
                          ) : (
                            <React.Fragment key={k}>{seg.s}</React.Fragment>
                          ),
                        )}
                      </span>
                      <button
                        className="mcopy"
                        onClick={() => void copy(m.text)}
                        type="button"
                        title="复制这条"
                      >
                        ⧉
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="chron">
              <textarea
                className="chatinput"
                value={draft}
                maxLength={CHAT_MAX_LEN}
                rows={1}
                placeholder={connected ? '回车发送 · Shift+回车换行' : '重连中，暂时发不出去'}
                disabled={!connected}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onChatKey}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
              />
              <button
                className="mini primary"
                onClick={() => void submit()}
                type="button"
                disabled={!connected || !draft.trim()}
              >
                发送
              </button>
            </div>
          </div>
        )}
      </aside>

      <footer className="ctl">
        <button
          className={'cbtn' + (isMicrophoneEnabled ? '' : ' off')}
          onClick={() => {
            const next = !isMicrophoneEnabled;
            // 记住「用户想要的状态」，<MicWatchdog> 靠它判断该不该自动救回
            setMicIntent(next);
            localParticipant.setMicrophoneEnabled(next).catch((e) => {
              console.warn('[mic] 切换失败', e);
            });
          }}
          type="button"
        >
          <span className="ico">{isMicrophoneEnabled ? '🎙' : '🔇'}</span>
          <span>麦克风</span>
        </button>
        <button
          className={'cbtn' + (isCameraEnabled ? '' : ' off')}
          onClick={() => localParticipant.setCameraEnabled(!isCameraEnabled)}
          type="button"
        >
          <span className="ico">{isCameraEnabled ? '📷' : '📷'}</span>
          <span>摄像头</span>
        </button>
        <button
          className={'cbtn' + (isScreenShareEnabled ? ' on' : '')}
          onClick={async () => {
            if (isScreenShareEnabled) {
              void localParticipant.setScreenShareEnabled(false).catch(() => undefined);
              return;
            }
            // 桌面壳：先弹自己的选择器选源，用户取消就干脆不发起共享。
            // 这样永远不会走到 Electron「请求了 video 却回空」的抛错路径。
            // 网页版没有 dshShell，直接走浏览器原生选择器。
            const shell = (
              window as unknown as {
                dshShell?: { pickSource?: () => Promise<string | null> };
              }
            ).dshShell;
            if (shell && typeof shell.pickSource === 'function') {
              const id = await shell.pickSource().catch(() => null);
              if (!id) return;
            }
            await localParticipant
              .setScreenShareEnabled(true, {
              // 【采集端就锁 720p30】不是在编码前缩，而是让 getDisplayMedia 直接给 720p：
              // 编码器不用处理 2560×1440 这类大画布，CPU 能省一半；
              // 同时也避免"1080p 源 → 720p 输出"的二次缩放损失。
              resolution: { width: CAPTURE_W, height: CAPTURE_H, frameRate: CAPTURE_FPS },
              // motion = 游戏/视频（码率紧张时保帧率），text = 文档（保锐度）。
              contentHint: loadHint(),
              // 【2026-11-06 回滚】这里原本把 AEC/NS/AGC 全关了（想让游戏声不被当人声处理），
              // 实测后果：系统音频是「默认播放设备的 loopback 混音」，耳机里正在放的观众语音
              // 也被一起采进伴音 → 观众听到自己说的话延迟约 200–500ms 回来（回声）。
              // 服务端日志可验证：关 DSP 时伴音是 ["TF_STEREO","TF_NO_DTX"]，没有 TF_ECHO_CANCELLATION。
              // 所以恢复成 Chrome 默认处理（`audio: true`，与改动前完全一致）。
              audio: true,
              })
              .catch((e) => {
                console.info('[share] 未开始共享：', (e && e.name) || e);
              });
          }}
          type="button"
        >
          <span className="ico">🖥</span>
          <span>{isScreenShareEnabled ? '停止共享' : '共享'}</span>
        </button>
        <span className="spacer" />
        <SettingsPanel />
        <button className="leave" onClick={leave} type="button">
          离开
        </button>
      </footer>

      {toast && <div className="toast">{toast}</div>}

      <style>{`
        .dsh-room{display:grid;height:100%;grid-template-columns:1fr 264px;
          grid-template-rows:38px 1fr 64px;grid-template-areas:"top top" "stage people" "ctl ctl";
          gap:8px;padding:8px;background:#0e1116;color:#dbe3ec;
          font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
        .dsh-room.collapsed{grid-template-columns:1fr 64px}
        .top{grid-area:top;display:flex;align-items:center;gap:10px;
          background:#151a21;border:1px solid #252e39;border-radius:10px;padding:0 12px;font-size:13px}
        .top .room{font-weight:600;letter-spacing:.3px}
        .top .chip{color:#8b97a6;border:1px solid #252e39;border-radius:999px;padding:2px 9px;font-size:11px}
        .top .chip.warn{color:#e0a33a;border-color:rgba(224,163,58,.35)}
        .top .spacer{flex:1}
        .mini{background:#1d2733;border:1px solid #2b3a4b;color:#cfdae6;border-radius:7px;
          padding:4px 10px;cursor:pointer;font-size:12px}
        .mini.primary{background:rgba(47,140,255,.16);border-color:#2f8cff;color:#eaf2ff}
        .stage{grid-area:stage;position:relative;display:flex;align-items:center;justify-content:center;
          gap:8px;background:#05070a;border:1px solid #252e39;border-radius:12px;overflow:hidden}
        .stage.grid{align-items:stretch;padding:8px}
        .stage.grid .screen{flex:1 1 0;min-width:0}
        .screen{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
        /* 关键：一定要用 width/height 100% + object-fit:contain 撑满舞台。
           之前只写了 max-width/max-height，video 元素会停在自己**固有尺寸**上，
           于是切到 720p/360p 时画面就"变小"而不是"变糊"——这是用户踩到的坑。 */
        .screen video{width:100%;height:100%;object-fit:contain;background:#000;border-radius:6px}
        .badge{position:absolute;left:12px;top:12px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.08);
          border-radius:8px;padding:4px 9px;font-size:11px;color:#b9c7d6}
        .badge b{color:#fff}
        .stagebtns{position:absolute;right:12px;top:12px;display:flex;gap:6px}
        .stagebtns .stopwatch{position:static}
        .audio{background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.12);border-radius:8px;
          padding:4px 9px;color:#8f9aa8;font-size:11px;cursor:pointer;white-space:nowrap}
        .person .audio{background:transparent;border:1px solid #2c3b4c;border-radius:999px;
          padding:2px 7px;font-size:11px;color:#7f8b9a;flex:none}
        .audio.on{color:#bcd9ff;border-color:rgba(47,140,255,.5)}
        .stopwatch{position:absolute;right:12px;top:12px;background:rgba(0,0,0,.55);
          border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px 9px;
          color:#c9d4e0;font-size:11px;cursor:pointer}
        .empty{text-align:center;color:#8b97a6;max-width:460px;padding:24px}
        .empty h3{margin:0 0 8px;color:#cfd9e4;font-size:15px;font-weight:600}
        .empty p{margin:0;line-height:1.7;color:#5d6875;font-size:12px}
        .empty .cta{margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
        .empty .cta button{background:rgba(47,140,255,.16);border:1px solid #2f8cff;color:#eaf2ff;
          border-radius:8px;padding:7px 12px;cursor:pointer;font-size:12px}
        /* 断线重连遮罩：盖住停住的画面，告诉用户"在重连，别退出" */
        .reconn{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;
          align-items:center;justify-content:center;gap:7px;background:rgba(8,11,15,.72);
          border-radius:12px;color:#cfdae6;font-size:13px;pointer-events:none}
        .reconn span{color:#8b97a6;font-size:11px}
        /* 摄像头：没有投屏时铺满主舞台 */
        .camgrid{width:100%;height:100%;display:grid;gap:8px;padding:8px;min-height:0}
        .camgrid.c1{grid-template-columns:1fr;grid-template-rows:1fr}
        .camgrid.c2{grid-template-columns:1fr 1fr;grid-template-rows:1fr}
        .camgrid.c3{grid-template-columns:repeat(3,1fr);grid-template-rows:1fr}
        .camgrid.c4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
        .camgrid.c5,.camgrid.c6{grid-template-columns:repeat(3,1fr);grid-template-rows:1fr 1fr}
        .camcell{position:relative;min-width:0;min-height:0;background:#000;border:1px solid #2c3441;
          border-radius:10px;overflow:hidden}
        .camcell video{width:100%;height:100%;object-fit:contain;display:block}
        .camname{position:absolute;left:6px;bottom:5px;font-size:11px;color:#dbe3ec;
          background:rgba(0,0,0,.55);border-radius:6px;padding:1px 6px}
        /* 有投屏时：摄像头缩成右下角画中画（宽度约舞台 28%，最多 320px） */
        .campip{position:absolute;right:10px;bottom:10px;width:min(28%,320px);
          display:flex;flex-direction:column;gap:6px;z-index:3}
        .campip .camcell{aspect-ratio:4/3;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.5)}
        .campip .camname{font-size:10px;padding:0 5px}
        .people{grid-area:people;background:#151a21;border:1px solid #252e39;border-radius:12px;
          overflow:hidden;padding:8px;display:flex;flex-direction:column;min-height:0}
        .people .dim{color:#5d6875}
        /* 右侧栏两个 tab：成员 / 聊天 */
        .ptabs{display:flex;gap:4px;padding:0 0 6px;flex:none}
        .ptab{flex:1;display:flex;align-items:center;justify-content:center;gap:4px;
          background:transparent;border:1px solid transparent;border-radius:8px;
          color:#8b97a6;font-size:11px;padding:5px 4px;cursor:pointer;position:relative}
        .ptab.on{background:#1b2734;border-color:#2b3a4b;color:#cfdae6}
        .pdot{position:absolute;top:-5px;right:0;background:#d9534f;color:#fff;font-size:9px;
          font-style:normal;border-radius:999px;padding:0 4px;line-height:14px;min-width:14px;text-align:center}
        .list{flex:1;min-height:0;overflow:auto}
        .person{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;
          margin-bottom:3px;position:relative}
        .person:hover{background:#1a222c}
        .person .bar{position:absolute;left:0;top:7px;bottom:7px;width:3px;border-radius:2px;background:transparent}
        .person.talking{background:rgba(57,192,122,.08)}
        .person.talking .bar{background:#39c07a}
        .person .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
        .person .name small{display:block;color:#5d6875;font-size:10px;margin-top:1px}
        .person .mic{width:16px;text-align:center;font-size:11px}
        .person .lvl{width:34px;height:4px;border-radius:2px;background:#222b36;overflow:hidden;flex:none}
        .person .lvl i{display:block;height:100%;background:#39c07a}
        .person .camon{flex:none;font-size:10px;padding:2px 7px;border-radius:999px;cursor:pointer;
          border:1px solid #2c3b4c;background:transparent;color:#7f8b9a;line-height:1.4}
        .person .camon.on{color:#bcd9ff;border-color:rgba(47,140,255,.5);background:rgba(47,140,255,.14)}
        .person .share{flex:none;font-size:10px;padding:2px 7px;border-radius:999px;cursor:pointer;
          border:1px solid rgba(47,140,255,.5);background:rgba(47,140,255,.14);color:#bcd9ff}
        .person .share.watching{background:rgba(57,192,122,.14);border-color:rgba(57,192,122,.5);color:#a7e8c4}
        .dsh-room.collapsed .people .pheadd span,.dsh-room.collapsed .people .person .name,
        .dsh-room.collapsed .people .person .lvl,.dsh-room.collapsed .people .person .share,
        .dsh-room.collapsed .people .person .cam,.dsh-room.collapsed .people .person .camon,.dsh-room.collapsed .people .person .mic{display:none}
        .dsh-room.collapsed .people .person{justify-content:center;padding:7px 0}
        .dsh-room.collapsed .people .person::after{content:"";width:20px;height:20px;border-radius:50%;
          background:#22303f;border:1px solid #2c3b4c}
        .dsh-room.collapsed .ptabs{flex-direction:column;gap:6px}
        .dsh-room.collapsed .ptabtxt{display:none}
        /* ---- 聊天面板 ---- */
        .chat{flex:1;min-height:0;display:flex;flex-direction:column;gap:6px}
        .chatbar{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:none}
        .chatbar .mini[disabled]{opacity:.45;cursor:default}
        .msgs{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;
          padding-right:2px;user-select:text}
        .chempty{color:#5d6875;font-size:11px;text-align:center;margin:auto;line-height:1.9}
        .chempty span{display:block;color:#465059;font-size:10px}
        .msg{display:flex;flex-direction:column;gap:2px;align-items:flex-start;max-width:100%}
        .msg.mine{align-items:flex-end}
        .mhead{display:flex;gap:6px;align-items:baseline;font-size:10px;color:#5d6875;padding:0 2px}
        .mhead .mname{color:#8b97a6}
        .mbody{position:relative;display:flex;align-items:flex-start;gap:4px;max-width:100%}
        .mtext{background:#1b2430;border:1px solid #24303d;border-radius:9px;padding:6px 9px;
          font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#dbe3ec;
          max-width:100%}
        .msg.mine .mtext{background:rgba(47,140,255,.16);border-color:rgba(47,140,255,.35);color:#eaf2ff}
        .mtext a{color:#6fb1ff;text-decoration:underline;cursor:copy}
        .mcopy{opacity:0;border:none;background:transparent;color:#7f8b9a;cursor:pointer;
          font-size:12px;padding:2px 3px;border-radius:5px;flex:none}
        .mbody:hover .mcopy{opacity:1}
        .mcopy:hover{background:#222c38;color:#cfdae6}
        .chron{display:flex;gap:6px;align-items:flex-end;flex:none}
        .chatinput{flex:1;min-height:32px;max-height:76px;resize:none;background:#0f141a;
          border:1px solid #263140;border-radius:9px;color:#dbe3ec;font-size:12.5px;
          line-height:1.5;padding:6px 8px;font-family:inherit}
        .chatinput:focus{outline:none;border-color:#2f8cff}
        .chatinput:disabled{opacity:.5}
        .toast{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:20;
          background:rgba(20,28,36,.96);border:1px solid #2c3b4c;color:#cfdae6;
          font-size:12px;padding:7px 14px;border-radius:999px;pointer-events:none;
          box-shadow:0 8px 24px rgba(0,0,0,.5)}
        .ctl{grid-area:ctl;display:flex;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;
          background:#151a21;border:1px solid #252e39;border-radius:12px;padding:0 12px}
        .ctl .spacer{flex:1}
        .cbtn{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:58px;
          padding:6px 8px;border-radius:9px;cursor:pointer;color:#c9d4e0;font-size:11px;
          background:transparent;border:1px solid transparent}
        .cbtn:hover{background:#1b232d}
        .cbtn.off{color:#8a5a5a}
        .cbtn.on{background:rgba(47,140,255,.16);border-color:#2f8cff;color:#eaf2ff}
        .cbtn .ico{font-size:15px;line-height:1}
        .leave{background:#c0392b;border:none;border-radius:9px;color:#fff;padding:9px 16px;
          font-size:12px;cursor:pointer}
        @media (max-width: 760px){
          .dsh-room{grid-template-columns:1fr;grid-template-rows:34px 1fr 56px 60px;
            grid-template-areas:"top" "stage" "people" "ctl"}
          .dsh-room.collapsed{grid-template-rows:34px 1fr 0 60px}
          .people{display:flex;flex-direction:row;align-items:center;gap:6px;overflow-x:auto;
            padding:6px 8px}
          .people .pheadd{display:none}
          .ptabs{flex:none;padding:0 4px 0 0}
          /* 手机上聊天面板铺在舞台上方，不跟成员挤一行 */
          .dsh-room.chatopen .people{position:fixed;left:6px;right:6px;top:42px;bottom:124px;z-index:30;
            flex-direction:column;align-items:stretch;overflow:hidden;padding:8px;
            box-shadow:0 12px 36px rgba(0,0,0,.65)}
          .people .person{min-width:150px;margin:0}
          .dsh-room.collapsed .people{display:none}
          .campip{width:min(42%,170px);right:8px;bottom:8px}
          .cbtn{min-width:46px;padding:6px 4px}
          .cbtn span:last-child{display:none}
          .leave{padding:7px 12px}
        }
      `}</style>
    </div>
  );
}

/** 单独一层：确保 <VideoTrack> 拿到稳定的 trackRef（避免父组件 re-render 时重复 attach） */
function SharedVideo({ trackRef }: { trackRef: TrackReference }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const track = trackRef.publication.videoTrack;
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    // 轨道 ended 时清空画面，否则 <video> 会定格在最后一帧（黑屏）
    const mst = track.mediaStreamTrack;
    const onEnded = () => {
      track.detach(el);
      el.srcObject = null;
    };
    mst?.addEventListener('ended', onEnded);
    return () => {
      mst?.removeEventListener('ended', onEnded);
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted />;
}

/**
 * 摄像头画面。单独一层组件，理由同 <SharedVideo>：
 * 父组件每秒都在重渲染（音量电平、订阅状态），把 attach/detach 放在 effect 里
 * 才能保证视频元素不会被反复重建、也不会丢帧。
 * 自己的画面做水平翻转（照镜子），别人的不翻。
 */
function CamVideo({ track, mirrored }: { track: VideoTrack; mirrored?: boolean }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    // 关摄像头后 track 会 ended，不清空就留一块黑
    const mst = track.mediaStreamTrack;
    const onEnded = () => {
      track.detach(el);
      el.srcObject = null;
    };
    mst?.addEventListener('ended', onEnded);
    return () => {
      mst?.removeEventListener('ended', onEnded);
      track.detach(el);
    };
  }, [track]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}