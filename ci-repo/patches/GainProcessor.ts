import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { getMicGain, onMicGainChange } from './MicGain';

/**
 * 只做增益的音频处理器（2026-11-09）。
 *
 * 为什么需要它：降噪（DeepFilterNet3）可以被用户关掉，一关就没有发布链路了，
 * 而「我的麦克风音量」是挂在链路上的 —— 于是关掉降噪后音量滑块会失效。
 * 这个处理器就是「关掉降噪时」的替代品：什么都不处理，只做增益。
 *
 * 链路：mic → GainNode → 发布
 */
export class GainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'dsh-gain';

  processedTrack?: MediaStreamTrack;

  private ctx?: AudioContext;

  private src?: MediaStreamAudioSourceNode;

  private gainNode?: GainNode;

  private dest?: MediaStreamAudioDestinationNode;

  private unsubscribe?: () => void;

  async init(opts: AudioProcessorOptions): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    this.src = ctx.createMediaStreamSource(new MediaStream([opts.track]));
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = getMicGain();
    this.dest = ctx.createMediaStreamDestination();

    this.src.connect(this.gainNode);
    this.gainNode.connect(this.dest);

    // 滑块拖动时实时生效，不需要重挂处理器
    this.unsubscribe = onMicGainChange((g) => {
      if (this.gainNode) this.gainNode.gain.value = g;
    });

    const [processed] = this.dest.stream.getAudioTracks();
    if (!processed) {
      throw new Error('增益处理器没有产出音频轨道');
    }
    this.processedTrack = processed;
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  async destroy(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      this.src?.disconnect();
    } catch {
      /* 忽略 */
    }
    try {
      this.gainNode?.disconnect();
    } catch {
      /* 忽略 */
    }
    this.processedTrack?.stop();
    const ctx = this.ctx;
    this.src = undefined;
    this.gainNode = undefined;
    this.dest = undefined;
    this.ctx = undefined;
    this.processedTrack = undefined;
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => {});
    }
  }
}
