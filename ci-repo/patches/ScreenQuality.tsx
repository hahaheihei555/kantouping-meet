'use client';

import * as React from 'react';
import { useRoomContext } from '@livekit/components-react';
import { LocalVideoTrack, RemoteVideoTrack, RoomEvent, Track } from 'livekit-client';
import {
  AUTO_BASE,
  BAD_TICKS,
  GOOD_TICKS,
  LOSS_BAD,
  LOSS_GOOD,
  RATE_TIERS,
  ShareHint,
  TCP_RATE,
  loadHint,
  mbps,
  saveHint,
} from './ShareConfig';

/**
 * 投屏画质面板（渲染在 <SettingsPanel> 的「画质」标签里，只负责内容）。
 *
 * 2026-11-06 改版：发布侧已经**锁死 720p30 单层**，没有 simulcast 层可选了，
 * 所以这个面板不再切分辨率，改成为"稳"服务的三件事：
 *   1. 码率上限（共享进行中即可实时生效，不用重新共享）
 *   2. 内容类型（游戏=保帧率 / 文字=保锐度，改的是采集轨道的 contentHint）
 *   3. 诊断：观众侧看收到的画面，主播侧看自己发出去的上行
 *
 * 为什么码率能实时改：WebRTC 允许对已发布的 sender 调 `setParameters()` 改
 * `encodings[0].maxBitrate`，编码器会立刻按新上限重算，不需要重新协商。
 */

type Diag = {
  res: string;
  fps: number;
  kbps: number;
  loss: number;
  jitter: number;
  /** 实际走的是 udp 还是 tcp —— TCP 下"丢包 0%"是假象，吞吐会被压死 */
  transport: string;
  /**
   * 【2026-11-08 新增】区分「网络卡」和「解码卡」的三个信号。
   * 症状都是"画面一顿一顿"，但处理方法完全不同：
   *   · 冻结次数/freeze 时长大、PLI 多  → 关键帧丢了在等下一帧，是网络
   *   · 帧被解码器丢弃（dropped）高、PLI 少 → 本机 CPU/GPU 跟不上，是机器
   *   · 缓冲时长高 → 抖动大，播放端在缓冲
   */
  dropped: number;
  freezes: number;
  freezeSec: number;
  pli: number;
  /** 平均抖动缓冲时长（毫秒） */
  bufferMs: number;
  /** 解码器：Chrome 自己的实现名，能看出是不是硬件解码 */
  decoder: string;
};
type PubDiag = { kbps: number; target: number; limit: string; enc: string; transport: string };

/**
 * 从 RTCStatsReport 里读出**当前选中的候选对**用的是 UDP 还是 TCP。
 * Chrome 的 sender/receiver.getStats() 都会带上 candidate-pair + local/remote-candidate，
 * 不用碰 LiveKit 的私有 API。
 */
function pickTransport(report: RTCStatsReport | undefined): string {
  if (!report) return '—';
  let best: Record<string, unknown> | undefined;
  const cands = new Map<string, Record<string, unknown>>();
  report.forEach((v) => {
    const s = v as unknown as Record<string, unknown>;
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
      best = s;
    }
    if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
      cands.set(String(s.id), s);
    }
  });
  if (!best) return '—';
  const lc = cands.get(String(best['localCandidateId']));
  const rc = cands.get(String(best['remoteCandidateId']));
  const p = String(lc?.['protocol'] ?? rc?.['protocol'] ?? '');
  return p === 'tcp' ? 'tcp' : p === 'udp' ? 'udp' : '—';
}

const dim = { color: '#6f7b8a' } as React.CSSProperties;

function Chip(props: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      style={{
        padding: '5px 9px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 12,
        border: props.active ? '1px solid #2f8cff' : '1px solid #2c3441',
        background: props.active ? 'rgba(47,140,255,.18)' : 'transparent',
        color: props.active ? '#eaf2ff' : '#c3ccd8',
      }}
    >
      {props.children}
    </button>
  );
}

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
      <span style={{ ...dim, width: 30, flex: 'none' }}>{props.label}</span>
      {props.children}
    </div>
  );
}

export function ScreenQuality() {
  const room = useRoomContext();
  const [hint, setHint] = React.useState<ShareHint>('motion');
  const [diag, setDiag] = React.useState<Diag | null>(null);
  const [pubDiag, setPubDiag] = React.useState<PubDiag | null>(null);

  React.useEffect(() => {
    setHint(loadHint());
  }, []);

  /** 自己正在共享的那一路屏幕轨道（没在共享时是 undefined） */
  const localScreen = React.useCallback((): LocalVideoTrack | undefined => {
    const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    return pub?.videoTrack as LocalVideoTrack | undefined;
  }, [room]);

  const applyRate = React.useCallback(
    async (v: number) => {
      const sender = localScreen()?.sender;
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = v;
        await sender.setParameters(params);
      } catch (e) {
        console.warn('设置投屏码率失败（下次开始共享时会用新值）', e);
      }
    },
    [localScreen],
  );

  const chooseHint = (h: ShareHint) => {
    setHint(h);
    saveHint(h);
    // contentHint 支持运行中修改，编码器会重新配置（改不了也没关系，下次共享生效）
    const mt = localScreen()?.mediaStreamTrack;
    if (mt) mt.contentHint = h;
  };

  // ---- 自动码率（2026-11-07）----
  // 只有发布者能改自己那一路的码率（SFU 不转码），所以判断都基于发布者自己能拿到的信号：
  //   · remote-inbound-rtp.fractionLost —— 服务器回给我们的上行丢包率
  //   · outbound-rtp.qualityLimitationReason === 'bandwidth' —— 编码器被带宽顶着
  //   · 当前选中的候选对是不是 TCP
  // 避免来回抖：连续 3 秒差才降档，连续 15 秒干净才升档。
  const auto = React.useRef<{ cur: number; bad: number; good: number }>({
    cur: AUTO_BASE,
    bad: 0,
    good: 0,
  });

  const setTier = React.useCallback(
    (v: number) => {
      auto.current.cur = v;
      void applyRate(v);
    },
    [applyRate],
  );

  /**
   * 【2026-11-07 试过又撤掉】自动降分辨率。
   *
   * 当时的想法：校园网 272–650 kbps 还硬撑 720p 是浪费，不如让编码器缩小画幅保帧率。
   * 实测（用户反馈 + 面板数据）：确实降到 480×270、帧率回到 29fps、码率反而涨到 1 Mbps
   * （画幅小 → 包少 → 丢包伤害小），但**看着太糊**，不如 720p@18fps。
   * 而且恢复门槛（>1.4 Mbps 持续 12 秒）在 1 Mbps 的链路上永远够不到，会卡死在低分辨率。
   * 用户拍板：不要自动降分辨率，维持 balanced（宁可掉帧不降画质）。
   * 如果以后要重做，务必先解决「恢复不了」这个问题（用 qualityLimitationReason 而不是绝对码率判断）。
   */
  const adapt = React.useCallback(
    (transport: string, limitReason: string, lossFrac: number) => {
      const st = auto.current;

      // 走 TCP：拥塞控制下高码率只会放大队头阻塞，直接压到最低档
      if (transport === 'tcp') {
        st.bad = 0;
        st.good = 0;
        if (st.cur !== TCP_RATE) setTier(TCP_RATE);
        return;
      }

      const idx = RATE_TIERS.indexOf(st.cur);
      const at = idx < 0 ? RATE_TIERS.length - 1 : idx;

      const isBad = lossFrac > LOSS_BAD || limitReason === 'bandwidth';
      const isGood = lossFrac < LOSS_GOOD && limitReason === 'none';

      if (isBad) {
        st.bad += 1;
        st.good = 0;
      } else if (isGood) {
        st.good += 1;
        st.bad = 0;
      } else {
        st.bad = Math.max(0, st.bad - 1);
      }

      if (st.bad >= BAD_TICKS && at > 0) {
        st.bad = 0;
        setTier(RATE_TIERS[at - 1]);
      } else if (st.good >= GOOD_TICKS && at < RATE_TIERS.length - 1) {
        st.good = 0;
        setTier(RATE_TIERS[at + 1]);
      }
    },
    [setTier],
  );

  // 实时诊断：观众侧 inbound-rtp / 主播侧 outbound-rtp，全部取浏览器标准 RTCStats。
  React.useEffect(() => {
    let cancelled = false;
    const inPrev = { id: '', bytes: 0, t: 0, lost: 0, recv: 0 };
    const outPrev = { bytes: 0, t: 0 };
    /** 最近 3 次采样窗口，用来把"每秒丢包率"抹平，避免数字乱跳 */
    const lossWin: number[] = [];

    const tick = async () => {
      // ---- 观众侧：我收到的那一路 ----
      let track: RemoteVideoTrack | undefined;
      let owner = '';
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (pub.source === Track.Source.ScreenShare && pub.isSubscribed && pub.videoTrack) {
            track = pub.videoTrack as RemoteVideoTrack;
            owner = p.identity;
          }
        });
      });

      if (!track) {
        setDiag(null);
        inPrev.id = '';
        inPrev.bytes = 0;
        inPrev.t = 0;
        inPrev.lost = 0;
        inPrev.recv = 0;
        lossWin.length = 0;
      } else {
        try {
          const report = await track.getRTCStatsReport();
          if (report && !cancelled) {
            report.forEach((entry) => {
              const s = entry as unknown as Record<string, number | string>;
              if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
              const bytes = Number(s.bytesReceived ?? 0);
              const now = performance.now();
              let kbps = 0;
              if (inPrev.id === owner && now > inPrev.t && bytes >= inPrev.bytes) {
                kbps = Math.round(((bytes - inPrev.bytes) * 8) / (now - inPrev.t));
              }
              const lost = Number(s.packetsLost ?? 0);
              const received = Number(s.packetsReceived ?? 0);

              // 【2026-11-06 修正】丢包必须按**每秒增量**算。
              // packetsLost / packetsReceived 是「从订阅开始累计」的计数器，一次历史抖动
              // （UDP→TCP 切换、重订阅、起始阶段的序列号缺口）会永久挂在上面，
              // 于是出现过「显示 30% 丢包，但同时 28fps / 2369kbps 正常播放」的矛盾数据。
              let lossPct = 0;
              const sameTrack = inPrev.id === owner && inPrev.recv > 0;
              const dLost = lost - inPrev.lost;
              const dRecv = received - inPrev.recv;
              if (sameTrack && dLost >= 0 && dRecv >= 0 && dLost + dRecv > 0) {
                lossWin.push((dLost / (dLost + dRecv)) * 100);
                if (lossWin.length > 3) lossWin.shift();
                lossPct = lossWin.reduce((a, b) => a + b, 0) / lossWin.length;
              } else if (!sameTrack) {
                // 换了一路/刚订阅：窗口清空，重新采样，避免把上一路的历史带过来
                lossWin.length = 0;
              }
              inPrev.id = owner;
              inPrev.bytes = bytes;
              inPrev.t = now;
              inPrev.lost = lost;
              inPrev.recv = received;

              const fpsRaw = Number(s.framesPerSecond);
              // 抖动缓冲：jitterBufferDelay / jitterBufferEmittedCount = 平均每帧在缓冲里待多久
              const jbDelay = Number(s.jitterBufferDelay ?? 0);
              const jbCount = Number(s.jitterBufferEmittedCount ?? 0);
              const bufferMs = jbCount > 0 ? Math.round((jbDelay / jbCount) * 1000) : 0;
              setDiag({
                res: `${s.frameWidth ?? 0}×${s.frameHeight ?? 0}`,
                fps: Number.isFinite(fpsRaw) ? Math.round(fpsRaw) : 0,
                kbps,
                loss: Math.round(Math.min(100, lossPct) * 10) / 10,
                jitter: Math.round(Number(s.jitter ?? 0) * 1000),
                transport: pickTransport(report),
                dropped: Number(s.framesDropped ?? 0),
                freezes: Number(s.freezeCount ?? 0),
                freezeSec: Math.round(Number(s.totalFreezesDuration ?? 0) * 10) / 10,
                pli: Number(s.pliCount ?? 0),
                bufferMs,
                decoder: String(s.decoderImplementation ?? ''),
              });
            });
          }
        } catch {
          /* 轨道刚被退订时可能抛错，忽略 */
        }
      }

      // ---- 主播侧：我自己发出去的那一路 ----
      const lv = localScreen();
      if (!lv) {
        setPubDiag(null);
        outPrev.bytes = 0;
        outPrev.t = 0;
        // 停止共享 → 归位到起步档，下次开始共享从头来
        auto.current = { cur: AUTO_BASE, bad: 0, good: 0 };
      } else {
        try {
          const report = await lv.getRTCStatsReport();
          if (report && !cancelled) {
            const transport = pickTransport(report);
            let limReason = 'none';
            let lossFrac = 0;

            report.forEach((entry) => {
              const s = entry as unknown as Record<string, number | string>;
              // 上行丢包：服务器通过 RTCP RR 回给我们的比例（remote-inbound-rtp）
              if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
                const fl = Number(s.fractionLost ?? 0);
                // 规范里是 0–1，但部分实现按 0–255 上报，这里统一到 0–1
                lossFrac = fl > 1 ? fl / 256 : fl;
              }
              if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
              limReason = String(s.qualityLimitationReason ?? 'none');

              const bytes = Number(s.bytesSent ?? 0);
              const now = performance.now();
              let kbps = 0;
              if (outPrev.t > 0 && now > outPrev.t && bytes >= outPrev.bytes) {
                kbps = Math.round(((bytes - outPrev.bytes) * 8) / (now - outPrev.t));
              }
              outPrev.bytes = bytes;
              outPrev.t = now;
              const reason = limReason;
              let target = 0;
              try {
                const p = lv.sender?.getParameters();
                target = Number(p?.encodings?.[0]?.maxBitrate ?? 0);
              } catch {
                /* ignore */
              }
              setPubDiag({
                kbps,
                target,
                // bandwidth = 上行不够（只能降码率）；cpu = 编码跟不上（该关游戏画质/换编码）
                limit:
                  reason === 'bandwidth'
                    ? '带宽'
                    : reason === 'cpu'
                      ? 'CPU'
                      : reason === 'other'
                        ? '其他'
                        : '无',
                enc: String(s.encoderImplementation ?? ''),
                transport,
              });
            });

            // 自动码率：根据线路 + 上行丢包 + 编码限制决定升降档
            adapt(transport, limReason, lossFrac);
          }
        } catch {
          /* 停止共享的瞬间可能抛错，忽略 */
        }
      }
    };

    const id = window.setInterval(tick, 1000);
    tick();
    const bump = () => {
      void tick();
    };
    room.on(RoomEvent.TrackPublished, bump);
    room.on(RoomEvent.TrackSubscribed, bump);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      room.off(RoomEvent.TrackPublished, bump);
      room.off(RoomEvent.TrackSubscribed, bump);
    };
  }, [room, localScreen, adapt]);

  return (
    <div style={{ color: '#d7dde5', fontSize: 12 }}>
      <div style={{ marginBottom: 9, color: '#cfd6e1', fontWeight: 600 }}>投屏画质</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        <Chip active onClick={() => undefined} title="采集端与编码端都已锁死，不随网络变化">
          720p30
        </Chip>
        <span style={dim}>固定</span>
      </div>

      <Row label="类型">
        <Chip
          active={hint === 'motion'}
          onClick={() => chooseHint('motion')}
          title="游戏 / 视频：码率紧张时优先保帧率"
        >
          游戏
        </Chip>
        <Chip
          active={hint === 'text'}
          onClick={() => chooseHint('text')}
          title="文档 / 代码：优先保文字锐度"
        >
          文字
        </Chip>
      </Row>

      <div style={{ borderTop: '1px solid #262d38', marginTop: 4, paddingTop: 9 }}>
        {diag ? (
          <div style={{ lineHeight: 1.85 }}>
            <div>
              <span style={dim}>收到</span>{' '}
              <b style={{ color: '#cfdae6' }}>
                {diag.res} · {diag.fps}fps
              </b>
              {diag.transport !== '—' && (
                <>
                  <span style={dim}>　线路</span>{' '}
                  <b style={{ color: diag.transport === 'tcp' ? '#e0a33a' : '#cfdae6' }}>
                    {diag.transport}
                  </b>
                </>
              )}
            </div>
            <div>
              <b style={{ color: diag.kbps < 1200 ? '#e0a33a' : '#7ee0a8' }}>{diag.kbps} kbps</b>
              <span style={dim}>　丢包</span>{' '}
              <b style={{ color: diag.loss > 2 ? '#e07a6a' : '#cfdae6' }}>{diag.loss}%</b>
              <span style={dim}>　抖动</span> <b style={{ color: '#cfdae6' }}>{diag.jitter}ms</b>
            </div>
            {/* 第三行：区分「网络卡」还是「解码卡」——昨天没丢包也卡，就是靠这行看出来的 */}
            <div>
              <span style={dim}>丢帧</span>{' '}
              <b style={{ color: diag.dropped > 10 ? '#e0a33a' : '#cfdae6' }}>{diag.dropped}</b>
              {diag.freezes > 0 && (
                <>
                  <span style={dim}>　冻结</span>{' '}
                  <b style={{ color: diag.freezes > 3 ? '#e07a6a' : '#cfdae6' }}>
                    {diag.freezes}次/{diag.freezeSec}s
                  </b>
                </>
              )}
              <span style={dim}>　缓冲</span>{' '}
              <b style={{ color: diag.bufferMs > 300 ? '#e0a33a' : '#cfdae6' }}>{diag.bufferMs}ms</b>
              {diag.pli > 0 && (
                <>
                  <span style={dim}>　PLI</span>{' '}
                  <b style={{ color: diag.pli > 10 ? '#e07a6a' : '#cfdae6' }}>{diag.pli}</b>
                </>
              )}
              {diag.decoder && (
                <>
                  <span style={dim}>　</span>
                  <b
                    style={{
                      color: /D3D|MediaFoundation|Hardware/i.test(diag.decoder)
                        ? '#7ee0a8'
                        : '#8b97a6',
                      fontWeight: 400,
                    }}
                  >
                    {/D3D|MediaFoundation|Hardware/i.test(diag.decoder) ? '硬解' : '软解'}
                  </b>
                </>
              )}
            </div>
          </div>
        ) : (
          !pubDiag && <div style={dim}>未接收</div>
        )}

        {pubDiag && (
          <div style={{ lineHeight: 1.85, marginTop: diag ? 6 : 0 }}>
            <div>
              <span style={dim}>上行</span>{' '}
              <b style={{ color: pubDiag.kbps < 1200 ? '#e0a33a' : '#7ee0a8' }}>
                {pubDiag.kbps} kbps
              </b>
              {pubDiag.target > 0 && <span style={dim}> / {mbps(pubDiag.target)}</span>}
            </div>
            <div>
              <span style={dim}>限制</span>{' '}
              <b style={{ color: pubDiag.limit === '无' ? '#cfdae6' : '#e0a33a' }}>{pubDiag.limit}</b>
              <span style={dim}>　编码</span>{' '}
              <b style={{ color: '#cfdae6', fontWeight: 500 }}>
                {pubDiag.enc ? pubDiag.enc.slice(0, 18) : '—'}
              </b>
              {pubDiag.transport !== '—' && (
                <>
                  <span style={dim}>　线路</span>{' '}
                  <b style={{ color: pubDiag.transport === 'tcp' ? '#e0a33a' : '#cfdae6' }}>
                    {pubDiag.transport}
                  </b>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
