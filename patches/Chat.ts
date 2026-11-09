/**
 * 房间内文字聊天：走 LiveKit 数据通道（reliable，topic = dsh-chat）。
 *
 * 为什么不落库：需求是「房间关了聊天记录就没了」。
 * 消息只存在各端内存里，页面一刷新 / 一退房就清空，服务器上什么都不留，
 * 后进房间的人也看不到之前聊的内容。
 */
import type { Room, RemoteParticipant } from 'livekit-client';

export const CHAT_TOPIC = 'dsh-chat';
export const CHAT_MAX_LEN = 500;

export type ChatMsg = {
  id: string;
  from: string;
  name: string;
  text: string;
  ts: number;
  self: boolean;
};

let seq = 0;
function newId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

/** 去掉首尾空白、统一换行、截断超长 */
export function clampText(t: string): string {
  const s = t.replace(/\r\n/g, '\n').trim();
  return s.length > CHAT_MAX_LEN ? s.slice(0, CHAT_MAX_LEN) : s;
}

/**
 * 发送一条消息。数据通道**不会回显给发送者**，所以调用方要自己把返回的消息
 * 追加到列表里，否则自己发的看不到。
 */
export async function sendChat(room: Room, text: string): Promise<ChatMsg | null> {
  const body = clampText(text);
  if (!body) return null;
  const me = room.localParticipant;
  const msg: ChatMsg = {
    id: newId(),
    from: me.identity,
    name: me.name || me.identity,
    text: body,
    ts: Date.now(),
    self: true,
  };
  const payload = new TextEncoder().encode(
    JSON.stringify({ i: msg.id, t: msg.text, s: msg.ts }),
  );
  await me.publishData(payload, { reliable: true, topic: CHAT_TOPIC });
  return msg;
}

/** 解析收到的数据包；不是聊天消息（或格式不对）就返回 null */
export function parseChat(payload: Uint8Array, participant?: RemoteParticipant): ChatMsg | null {
  let obj: { t?: unknown; i?: unknown; s?: unknown };
  try {
    obj = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!obj || typeof obj.t !== 'string') return null;
  const text = clampText(obj.t);
  if (!text) return null;
  const from = participant?.identity ?? '';
  return {
    id: typeof obj.i === 'string' ? obj.i : newId(),
    from,
    name: participant?.name || from || '未知',
    text,
    ts: typeof obj.s === 'number' ? obj.s : Date.now(),
    self: false,
  };
}

/**
 * 复制到剪贴板。https 下用 clipboard API，
 * 失败（比如 Electron 里权限被拦）退回 textarea + execCommand。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走下面的兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** HH:MM */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 导出成纯文本，供「复制全部」 */
export function toPlainText(msgs: ChatMsg[]): string {
  return msgs.map((m) => `${hhmm(m.ts)} ${m.name}: ${m.text}`).join('\n');
}

/**
 * 把文本切成「普通文字 / 链接」两种片段。
 * 链接我们**不做跳转**：浏览器里能开、Electron 壳里没配 openExternal 会变成空白窗，
 * 所以统一点击=复制链接，用户自己粘到浏览器里。
 */
export function splitLinks(text: string): Array<{ s: string; url: boolean }> {
  const out: Array<{ s: string; url: boolean }> = [];
  const re = /https?:\/\/[^\s<>"'（）()]+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ s: text.slice(last, m.index), url: false });
    out.push({ s: m[0], url: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ s: text.slice(last), url: false });
  return out;
}
