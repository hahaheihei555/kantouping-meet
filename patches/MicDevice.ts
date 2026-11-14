'use client';

/**
 * 麦克风设备小工具（2026-11-13）。
 *
 * 起因：用户「老冰棍」进房时弹「Requested device not found」。
 * 他上次选的麦克风（蓝牙耳机 / USB 麦）这次不在，客户端仍拿那个 deviceId 去开麦，
 * getUserMedia 抛 NotFoundError → Room 发 MediaDevicesError → 整个房间弹错误框，
 * 人就卡在房间里出不来。
 *
 * 原则：**设备没了不该导致进不了房**，退回系统默认设备就行，同时在设置里提醒他重新选。
 */
import type { LocalParticipant, Room } from 'livekit-client';

/** 记住的输入设备（空 = 跟随系统默认）。PreJoin 也会读它做预选。 */
export const MIC_KEY = 'dsh-audio-input';

/** 设备现在还在不在。枚举失败（没授权等）时返回 true，免得误判。 */
export async function deviceExists(kind: MediaDeviceKind, id?: string | null): Promise<boolean> {
  if (!id) return true;
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    if (!list.length) return true;
    return list.some((d) => d.kind === kind && d.deviceId === id);
  } catch {
    return true;
  }
}

/** 忘掉记住的设备（设备已不在时调用）。 */
export function forgetSavedMic(): void {
  try {
    window.localStorage.setItem(MIC_KEY, '');
  } catch {
    /* 隐私模式忽略 */
  }
}

function isMissingDeviceError(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  return name === 'NotFoundError' || name === 'OverconstrainedError';
}

/**
 * 开麦，但绝不因为「保存的设备不存在」而失败：
 * 失败就清掉设备约束，用系统默认设备重来一次。
 * 调用方只需要处理真正的失败（没权限、设备被占用等）。
 */
export async function enableMicSafely(room: Room, lp: LocalParticipant): Promise<void> {
  try {
    await lp.setMicrophoneEnabled(true);
    return;
  } catch (e) {
    if (!isMissingDeviceError(e)) throw e;
    console.warn('[mic] 记住的输入设备不在了，改用系统默认设备', e);
  }
  forgetSavedMic();
  if (room.options.audioCaptureDefaults) {
    room.options.audioCaptureDefaults.deviceId = undefined;
  }
  await lp.setMicrophoneEnabled(true);
}
