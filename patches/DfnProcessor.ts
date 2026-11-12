import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { getMicGain, onMicGainChange } from './MicGain';

/**
 * 把 DeepFilterNet3（@workadventure/noise-suppression）包成 LiveKit 的 TrackProcessor。
 *
 * 为什么要自己包一层：LiveKit 的音频处理入口只有 `LocalAudioTrack.setProcessor()`，
 * 而那个包只提供 AudioWorklet 节点（`createDeepFilterNetAudioWorklet`），
 * 中间的胶水就是我们这个类。
 *
 * 关键实现点：
 * 1. **单独建 48kHz 的 AudioContext**。DeepFilterNet3 只接受 48kHz，
 *    它对非 48k 直接抛错；不能用 SDK 传进来的 audioContext 碰运气。
 * 2. **模块用运行时动态 import**（`/dfn/deepfilternet.js`），不走打包器。
 *    这样不用往 meet 的 package.json / pnpm-lock 里加依赖，省掉 lockfile 冲突，
 *    也避免了把 22MB 的 wasm+模型塞进 git。
 * 3. `pauseGateLookaheadFrames: 1` —— 停顿门的前瞻从 3 帧降到 1 帧，
 *    总延迟从 71ms 降到约 51ms（模型 30ms + 重采样 10.7ms + 前瞻 10ms）。
 * 4. `bypassUntilReady: true` —— 模型加载期间声音直通，不会“开麦后先哑几秒”。
 * 5. **`postGain: true`（2026-11-11）** —— 打开包内置的电平归一器：目标 -23dBFS，
 *    小声最多 +15dB、大声最多 -10dB，只在说话帧上动（约 5dB/秒），带 0.9 峰值上限防削波。
 *    客户端已把浏览器 `autoGainControl` 关掉：那个跑在降噪**之前**，会把底噪一起抬起来，
 *    而且调得太快会「突然变大」。归一放到降噪之后，五个人的音量才会齐。
 * 6. **预热 + 未就绪兜底（2026-11-12）**。
 *    症状：刚进房那几秒（模型下载 + 编译期间音频直通），有风扇/空调声的人很吵。
 *    解法两层：
 *      a. `warmupDfn()` 在 PreJoin 页就开始加载，把窗口提前吃掉（主要手段）；
 *      b. 万一窗口还在：100Hz 高通 + 压低 12dB，就绪后 300ms 补回。
 *    注意 2026-11-11 曾经加过 trim 又撤掉，理由是 postGain 从 0dB 起步、电平连续；
 *    现在诉求变成「别吵」，所以宁可开头小声。别再为了"电平连续"把它删掉。
 */

type DfnWorkletHandle = {
  node: AudioWorkletNode;
  ready: Promise<unknown>;
  dispose(): void;
};

type DfnModule = {
  DEEPFILTERNET_SAMPLE_RATE: number;
  createDeepFilterNetAudioWorklet(
    context: BaseAudioContext,
    options?: {
      speechAttenuationDb?: number;
      pauseAttenuationDb?: number;
      pauseGateLookaheadFrames?: number;
      minSpeechFrames?: number;
      bypassUntilReady?: boolean;
      postGain?: boolean;
    },
  ): Promise<DfnWorkletHandle>;
};

export type DfnOptions = {
  /** 说话时允许的最大衰减（dB）。太高会发闷，默认 25。 */
  speechAttenuationDb: number;
  /** 停顿期衰减（dB）。这是治呼吸/吸气的关键参数，默认 65。 */
  pauseAttenuationDb: number;
  /** 停顿门前瞻帧数（10ms/帧）。1 = 省 20ms，默认 1。 */
  pauseGateLookaheadFrames: number;
};

export const DFN_DEFAULTS: DfnOptions = {
  speechAttenuationDb: 25,
  pauseAttenuationDb: 65,
  pauseGateLookaheadFrames: 1,
};

const DFN_MODULE_URL = '/dfn/deepfilternet.js';
const DFN_SAMPLE_RATE = 48000;

/**
 * 降噪未就绪时的兜底（2026-11-12）。
 *
 * 现象：刚进房那几秒（模型 22MB 下载 + 编译期间）音频直通，别人听到的是**原始麦克风**，
 * 风扇/空调/电流声重的人就很明显。
 *
 * 兜底做两件事：100Hz 高通（砍掉低频轰鸣）+ 压低 12dB（听感从"吵"变成"远"）。
 * 模型就绪后 300ms 内把增益补回、高通放开。
 * 真正的解法是 warmupDfn()：进房前就把模型加载好，这个窗口大多数时候根本不出现。
 */
const BYPASS_TRIM = 0.25; // -12dB
const BYPASS_HIGHPASS_HZ = 100;

let warmPromise: Promise<void> | null = null;

/**
 * 预热降噪模型（2026-11-12）。
 *
 * 用户在 PreJoin 页填名字/调音量的时候就把 22MB 模型下载 + wasm 编译做完，
 * 等真正开麦，DfnProcessor.init 只剩建节点，没有裸奔窗口。
 * 幂等；失败会清空缓存让下次调用重试。
 */
export function warmupDfn(): Promise<void> {
  if (warmPromise) return warmPromise;
  if (typeof window === 'undefined') return Promise.resolve();
  warmPromise = (async () => {
    const ctx = new AudioContext({ sampleRate: DFN_SAMPLE_RATE });
    try {
      const mod = (await import(/* webpackIgnore: true */ DFN_MODULE_URL)) as unknown as DfnModule;
      // 这一步完成时，wasm 已编译、模型字节已进模块级缓存（包内用 Map 缓存）
      const handle = await mod.createDeepFilterNetAudioWorklet(ctx, {
        bypassUntilReady: false,
        postGain: true,
      });
      // 再等 worklet 真正初始化完（df_create），最多 5 秒。
      // 这里必须挂 catch：提前 dispose 会让 ready 在 30 秒后超时 reject，
      // 不接住就是一条 unhandled rejection。
      await Promise.race([
        handle.ready.catch(() => undefined),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      handle.dispose();
    } finally {
      await ctx.close().catch(() => {});
    }
  })().catch((e) => {
    console.warn('[dfn] 预热失败，开麦时会再试', e);
    warmPromise = null;
  });
  return warmPromise;
}

export class DfnProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'dsh-deepfilternet';

  processedTrack?: MediaStreamTrack;

  private ctx?: AudioContext;

  private src?: MediaStreamAudioSourceNode;

  private dest?: MediaStreamAudioDestinationNode;

  private handle?: DfnWorkletHandle;

  /**
   * 输出增益节点（2026-11-09 加）。
   * 「我的麦克风音量」就靠它：链路变成 mic → 降噪 worklet → gain → 发布。
   * 拖动滑块时只改 gain.gain.value，不需要重挂处理器。
   */
  private gainNode?: GainNode;

  private unsubscribeGain?: () => void;

  /** 未就绪时开的低频高通，就绪后放开（见 BYPASS_HIGHPASS_HZ） */
  private hp?: BiquadFilterNode;

  /** worklet 是否已经就绪；未就绪时增益要压低（见 BYPASS_TRIM） */
  private ready = false;

  private opts: DfnOptions;

  constructor(opts: DfnOptions = DFN_DEFAULTS) {
    this.opts = { ...opts };
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = new AudioContext({ sampleRate: DFN_SAMPLE_RATE });
    this.ctx = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const mod = (await import(/* webpackIgnore: true */ DFN_MODULE_URL)) as unknown as DfnModule;

    this.handle = await mod.createDeepFilterNetAudioWorklet(ctx, {
      speechAttenuationDb: this.opts.speechAttenuationDb,
      pauseAttenuationDb: this.opts.pauseAttenuationDb,
      pauseGateLookaheadFrames: this.opts.pauseGateLookaheadFrames,
      minSpeechFrames: 1,
      bypassUntilReady: true,
      // 【2026-11-11】打开电平归一：把每个人的说话音量拉到 -23 dBFS 附近
      // （小声最多 +15dB、大声最多 -10dB，只在说话帧上动，约 5dB/秒）。
      // 客户端已关掉浏览器 autoGainControl，就是让它在降噪之后干这活——
      // 否则五个人的麦灵敏度和距离差异会原样送到耳朵里。
      postGain: true,
    });

    this.src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.dest = ctx.createMediaStreamDestination();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = BYPASS_HIGHPASS_HZ;
    hp.Q.value = 0.7;
    this.hp = hp;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = getMicGain() * BYPASS_TRIM;
    this.src.connect(hp);
    hp.connect(this.handle.node);
    this.handle.node.connect(this.gainNode);
    this.gainNode.connect(this.dest);
    this.unsubscribeGain = onMicGainChange((g) => {
      if (this.gainNode) this.gainNode.gain.value = g * (this.ready ? 1 : BYPASS_TRIM);
    });

    // 就绪：300ms 内把增益补回用户设定值、放开低频，避免"先小后大"的硬跳变
    this.handle.ready
      .then(() => {
        this.ready = true;
        const node = this.gainNode;
        const c = this.ctx;
        if (!node || !c) return;
        const t = c.currentTime;
        node.gain.cancelScheduledValues(t);
        node.gain.setValueAtTime(node.gain.value, t);
        node.gain.linearRampToValueAtTime(getMicGain(), t + 0.3);
        this.hp?.frequency.setValueAtTime(10, t);
      })
      .catch(() => {
        // 模型没起来：保持压低 + 高通，宁可听不清也别让噪音刺耳
      });

    const [processed] = this.dest.stream.getAudioTracks();
    if (!processed) {
      throw new Error('DeepFilterNet3 没有产出音频轨道');
    }
    this.processedTrack = processed;
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.unsubscribeGain?.();
    this.unsubscribeGain = undefined;
    try {
      this.handle?.dispose();
    } catch {
      /* 已释放 */
    }
    try {
      this.src?.disconnect();
    } catch {
      /* 已断开 */
    }
    try {
      this.gainNode?.disconnect();
    } catch {
      /* 已断开 */
    }
    try {
      this.hp?.disconnect();
    } catch {
      /* 已断开 */
    }
    this.processedTrack?.stop();
    const ctx = this.ctx;
    this.ready = false;
    this.handle = undefined;
    this.src = undefined;
    this.hp = undefined;
    this.gainNode = undefined;
    this.dest = undefined;
    this.ctx = undefined;
    this.processedTrack = undefined;
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
  }
}