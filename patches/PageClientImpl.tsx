'use client';

import React from 'react';
import { decodePassphrase } from '@/lib/client-utils';
import { KeyboardShortcuts } from '@/lib/KeyboardShortcuts';
import { ConnectionDetails } from '@/lib/types';
import { LocalUserChoices, PreJoin, RoomContext } from '@livekit/components-react';
import {
  ExternalE2EEKeyProvider,
  RoomOptions,
  VideoCodec,
  VideoPresets43,
  Room,
  DeviceUnsupportedError,
  RoomConnectOptions,
  RoomEvent,
  TrackPublishDefaults,
  VideoCaptureOptions,
} from 'livekit-client';
import { useRouter } from 'next/navigation';
import { RoomLayout } from './RoomLayout';
import { AUTO_BASE, CAPTURE_FPS } from './ShareConfig';
import { useSetupE2EE } from '@/lib/useSetupE2EE';
import { useLowCPUOptimizer } from '@/lib/usePerfomanceOptimiser';

const CONN_DETAILS_ENDPOINT =
  process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details';

export function PageClientImpl(props: {
  roomName: string;
  serverUrl?: string;
  region?: string;
  hq: boolean;
  codec: VideoCodec;
  singlePeerConnection: boolean;
}) {
  const [preJoinChoices, setPreJoinChoices] = React.useState<LocalUserChoices | undefined>(
    undefined,
  );
  const preJoinDefaults = React.useMemo(() => {
    // 桌面壳约定（2026-11-06）：?name=昵称 预填，并记住上次用过的昵称。
    // 目的：双击图标 → 直接进房，而不是每次都停在 PreJoin 页输名字。
    let saved = '';
    let urlName = '';
    try {
      saved = window.localStorage.getItem('dsh-name') ?? '';
      urlName = new URLSearchParams(window.location.search).get('name') ?? '';
    } catch {
      /* SSR / 隐私模式 */
    }
    return {
      username: urlName || saved,
      // 【默认关闭】进房不自动开摄像头：这个房间的用途是看投屏，摄像头开着只会
      // 白占上行带宽和 CPU（5 个人全开 720p 就是额外 3-5 Mbps）。
      // 想露脸的人进房后点工具栏的摄像头按钮随时开，不影响任何功能。
      videoEnabled: false,
      audioEnabled: true,
    };
  }, []);
  const [connectionDetails, setConnectionDetails] = React.useState<ConnectionDetails | undefined>(
    undefined,
  );

  // DNS and TLS state is cached by the browser, not the Room, so warming up on a separate Room
  // speeds up the conference Room's connect.
  React.useEffect(() => {
    if (props.serverUrl) {
      new Room().prepareConnection(props.serverUrl);
    }
  }, [props.serverUrl]);

  const handlePreJoinSubmit = React.useCallback(async (values: LocalUserChoices) => {
    try {
      if (values.username) window.localStorage.setItem('dsh-name', values.username);
    } catch {
      /* 隐私模式 */
    }
    setPreJoinChoices(values);
    const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
    url.searchParams.append('roomName', props.roomName);
    url.searchParams.append('participantName', values.username);
    if (props.region) {
      url.searchParams.append('region', props.region);
    }
    const connectionDetailsResp = await fetch(url.toString());
    const connectionDetailsData = await connectionDetailsResp.json();
    setConnectionDetails(connectionDetailsData);
  }, []);
  const handlePreJoinError = React.useCallback((e: any) => console.error(e), []);

  /**
   * 桌面壳约定：?autojoin=1 + 已经有昵称 → 跳过 PreJoin 直接进房。
   * 网页版行为不变：不带这个参数时仍然停在 PreJoin 页（可以改名字、选设备）。
   */
  const autoJoined = React.useRef(false);
  React.useEffect(() => {
    if (autoJoined.current) return;
    let autojoin = false;
    try {
      autojoin = new URLSearchParams(window.location.search).get('autojoin') === '1';
    } catch {
      return;
    }
    if (!autojoin) return;
    const name = (preJoinDefaults.username || '').trim();
    if (!name) return; // 第一次没有昵称，让他先填一次
    autoJoined.current = true;
    // 设备字段故意留空 = 用系统默认设备（正常走 PreJoin 时才会带上用户选的 deviceId）
    void handlePreJoinSubmit({ ...preJoinDefaults, username: name } as LocalUserChoices);
  }, [handlePreJoinSubmit, preJoinDefaults]);

  return (
    <main data-lk-theme="default" style={{ height: '100%' }}>
      {connectionDetails === undefined || preJoinChoices === undefined ? (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <PreJoin
            defaults={preJoinDefaults}
            onSubmit={handlePreJoinSubmit}
            onError={handlePreJoinError}
          />
        </div>
      ) : (
        <VideoConferenceComponent
          connectionDetails={connectionDetails}
          userChoices={preJoinChoices}
          options={{
            codec: props.codec,
            hq: props.hq,
            singlePeerConnection: props.singlePeerConnection,
          }}
        />
      )}
    </main>
  );
}

function VideoConferenceComponent(props: {
  userChoices: LocalUserChoices;
  connectionDetails: ConnectionDetails;
  options: {
    hq: boolean;
    codec: VideoCodec;
    singlePeerConnection: boolean;
  };
}) {
  const keyProvider = new ExternalE2EEKeyProvider();
  const { worker, e2eePassphrase } = useSetupE2EE();
  const e2eeEnabled = !!(e2eePassphrase && worker);

  const [e2eeSetupComplete, setE2eeSetupComplete] = React.useState(false);

  const roomOptions = React.useMemo((): RoomOptions => {
    // 默认 HP/AV1 类编码器都是软编。VP9 1080p30 三层软编能吃掉 4-8 个核，
    // 一边打游戏一边投屏必然追不上，浏览器就把画面缩到几百像素宽。
    // H.264 走显卡硬编（NVENC / QuickSync），1080p30 几乎零成本。
    let videoCodec: VideoCodec | undefined = props.options.codec ? props.options.codec : 'h264';
    if (e2eeEnabled && (videoCodec === 'av1' || videoCodec === 'vp9')) {
      videoCodec = undefined;
    }
    // 【摄像头：2026-11-06 起按"画中画尺寸"配置】
    // 以前沿用 720p/1.7Mbps —— 但摄像头画面在界面上只是一块 28% 宽的小窗，
    // 5 个人全开就是每个观众 6.8 Mbps，校园网直接爆掉。
    // 现在锁 640×480@20 / 800kbps：画中画够清楚，5 人全开也只要 3.2 Mbps。
    const videoCaptureDefaults: VideoCaptureOptions = {
      deviceId: props.userChoices.videoDeviceId ?? undefined,
      resolution: VideoPresets43.h480,
    };
    // 【2026-11-06 定型：锁死 720p30 单层】
    // 实测结论：这条链路观众侧下来只有约 2.3 Mbps、丢包 14%。
    // 原来给的是 12 Mbps + 1080p/720p 双层 —— 编码器一直在追一个发不出去的目标，
    // BWE 一压就砍帧率，画面不糊但卡。现在把目标压到链路能喂住的水平，帧率才稳。
    // 【2026-11-07】码率全自动：起步 2.4 Mbps，由 <ScreenQuality> 根据实时丢包/线路
    // 在 2.4 → 1.6 → 1.0 之间自动升降（走 TCP 时直接压到 1.0）。
    const screenRate = AUTO_BASE;
    const publishDefaults = {
      dtx: false,
      // 不再编多层：单层省一半编码 CPU、上行目标从 12 Mbps 降到 2.4 Mbps。
      // 代价是弱网观众没有更低一档可退，但 5 个人、720p 这个码率下问题不大。
      simulcast: false,
      videoSimulcastLayers: [],
      screenShareSimulcastLayers: [],
      screenShareEncoding: {
        maxBitrate: screenRate,
        maxFramerate: CAPTURE_FPS,
      },
      // 摄像头（默认关，点了才开）：码率上限跟采集分辨率配套，见上面 videoCaptureDefaults 注释
      videoEncoding: {
        maxBitrate: 800_000,
        maxFramerate: 20,
      },
      red: !e2eeEnabled,
      videoCodec,
      // 【2026-11-07 改动：maintain-resolution → balanced】
      // 原来锁「宁可掉帧也不降分辨率」。但实测晚高峰带宽被压时，
      // 编码器一路砍帧率到 0–5fps，画面变幻灯片 —— 比糊还难受。
      // balanced 让编码器在「降分辨率」和「掉帧」之间自己权衡，
      // 带宽不足时优先保住 20–30fps，代价是分辨率小幅下降。
      // 有单层 + 2.4 Mbps 上限兜底，分辨率不会塌到不可读。
      degradationPreference: 'balanced',
    } as TrackPublishDefaults;
    return {
      videoCaptureDefaults: videoCaptureDefaults,
      publishDefaults: publishDefaults,
      audioCaptureDefaults: {
        deviceId: props.userChoices.audioDeviceId ?? undefined,
        // 回声消除保留；**噪声抑制和自动增益都关掉**：
        // - 噪声抑制：由 DeepFilterNet3 做更强的降噪（见 <NoiseControl />），两层叠加会让语音发闷
        // - 自动增益（2026-11-11 关）：浏览器 AGC 跑在降噪**之前**，会把底噪跟着人声一起抬起来，
        //   而且调节速度太快，开口瞬间会「突然变大」。
        //   电平归一改由 DeepFilterNet3 内置的 PostGain 负责（在降噪之后，只在说话帧上动，5dB/秒）。
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
      // 【刻意关掉】adaptiveStream 会按「元素尺寸 + 带宽估计」自动给每个观众选 simulcast 层，
      // 结果就是网络稍抖就被塞到 360p，投屏文字糊成一片。
      // 现在改成固定层，由左下角的 <ScreenQuality /> 手动切换 1080p / 720p / 360p。
      adaptiveStream: false,
      dynacast: true,
      e2ee: keyProvider && worker && e2eeEnabled ? { keyProvider, worker } : undefined,
      singlePeerConnection: props.options.singlePeerConnection,
    };
  }, [props.userChoices, props.options.hq, props.options.codec]);

  const room = React.useMemo(() => new Room(roomOptions), []);

  React.useEffect(() => {
    if (e2eeEnabled) {
      keyProvider
        .setKey(decodePassphrase(e2eePassphrase))
        .then(() => {
          room.setE2EEEnabled(true).catch((e) => {
            if (e instanceof DeviceUnsupportedError) {
              alert(
                `You're trying to join an encrypted meeting, but your browser does not support it. Please update it to the latest version and try again.`,
              );
              console.error(e);
            } else {
              throw e;
            }
          });
        })
        .then(() => setE2eeSetupComplete(true));
    } else {
      setE2eeSetupComplete(true);
    }
  }, [e2eeEnabled, room, e2eePassphrase]);

  const connectOptions = React.useMemo((): RoomConnectOptions => {
    const opts: RoomConnectOptions = {
      autoSubscribe: true,
    };
    // 【实验开关，仅排查用】?relay=1 强制媒体走 TURN 中继。
    // 用途：判断校园网是不是只对 UDP 媒体主端口（7882）限速/丢包 ——
    // 中继走 3478 与 50000–50100 的随机端口，如果丢包消失，就是端口级 QoS。
    if (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('relay') === '1'
    ) {
      opts.rtcConfig = { iceTransportPolicy: 'relay' };
    }
    return opts;
  }, []);

  React.useEffect(() => {
    room.on(RoomEvent.Disconnected, handleOnLeave);
    room.on(RoomEvent.EncryptionError, handleEncryptionError);
    room.on(RoomEvent.MediaDevicesError, handleError);

    if (e2eeSetupComplete) {
      room
        .connect(
          props.connectionDetails.serverUrl,
          props.connectionDetails.participantToken,
          connectOptions,
        )
        .catch((error) => {
          handleError(error);
        });
      if (props.userChoices.videoEnabled) {
        room.localParticipant.setCameraEnabled(true).catch((error) => {
          handleError(error);
        });
      }
      if (props.userChoices.audioEnabled) {
        room.localParticipant.setMicrophoneEnabled(true).catch((error) => {
          handleError(error);
        });
      }
    }
    return () => {
      room.off(RoomEvent.Disconnected, handleOnLeave);
      room.off(RoomEvent.EncryptionError, handleEncryptionError);
      room.off(RoomEvent.MediaDevicesError, handleError);
    };
  }, [e2eeSetupComplete, room, props.connectionDetails, props.userChoices]);

  // 【关键】Meet 自带的 CPU 降级器默认做两件破坏画质的事：
  //   1. 本地轨道一触发 LocalTrackCpuConstrained 就 calling prioritizePerformance() —— 把
  //      正在投屏的那一路编码降分辨率/降帧率（打游戏时 CPU 紧张，必触发）；
  //   2. 把所有远程视频轨道钉到 VideoQuality.LOW（360p）。
  // 这就是"明明千兆带宽、硬件也不差，画面还是糊"的真凶之一。
  // 用户明确表示硬件都很新，不怕性能问题，所以这里整体关掉降级，画质只由手动档位决定。
  const lowPowerMode = useLowCPUOptimizer(room, {
    reducePublisherVideoQuality: false,
    reduceSubscriberVideoQuality: false,
  });

  const router = useRouter();
  const handleOnLeave = React.useCallback(() => router.push('/'), [router]);
  const handleError = React.useCallback((error: Error) => {
    console.error(error);
    alert(`Encountered an unexpected error, check the console logs for details: ${error.message}`);
  }, []);
  const handleEncryptionError = React.useCallback((error: Error) => {
    console.error(error);
    alert(
      `Encountered an unexpected encryption error, check the console logs for details: ${error.message}`,
    );
  }, []);

  React.useEffect(() => {
    if (lowPowerMode) {
      console.warn('Low power mode enabled');
    }
  }, [lowPowerMode]);

  return (
    <div className="lk-room-container">
      <RoomContext.Provider value={room}>
        <KeyboardShortcuts />
        <RoomLayout />
      </RoomContext.Provider>
    </div>
  );
}
