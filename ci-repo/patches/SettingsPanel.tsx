'use client';

import * as React from 'react';
import { AudioMixer } from './AudioMixer';
import { NoiseControl } from './NoiseControl';
import { ScreenQuality } from './ScreenQuality';

/**
 * 统一的设置面板容器（画质 / 降噪 / 音量）。
 *
 * 为什么要有这一层：
 * 之前三个功能各自 `position: fixed` 漂在页面上，谁也不知道对方的尺寸，
 * 结果在小窗口里互相压住（音量盖住画质列表）。这类问题靠调 `bottom` 数字是治不好的，
 * 只要再加一个面板就会再次重叠。
 *
 * 现在的职责划分：
 * - **本组件**：唯一的一个浮层，负责定位、开合、点外部关闭、Esc 关闭、标签切换、移动端全宽
 * - 三个子组件：只渲染**内容**（不再自己定位、不再自带开合按钮）
 * - 三个子组件**始终挂载**（关闭时用 `display:none` 隐藏，而不是卸载），
 *   因为降噪要把 DeepFilterNet3 挂在麦克风轨道上、音量要持续作用于新订阅的轨道，
 *   一旦卸载就会断掉引擎。
 */

type Tab = 'screen' | 'noise' | 'mixer';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'screen', label: '画质' },
  { key: 'noise', label: '降噪' },
  { key: 'mixer', label: '音量' },
];

export function SettingsPanel() {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>('screen');

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const show = (t: Tab): React.CSSProperties => ({
    display: tab === t ? 'block' : 'none',
  });

  return (
    <div className="sp">
      {open && <div className="spcatch" onClick={() => setOpen(false)} />}

      <div className="sppanel" style={{ display: open ? 'block' : 'none' }}>
        <div className="sptabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={'sptab' + (tab === t.key ? ' on' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
          <button type="button" className="spx" onClick={() => setOpen(false)} title="关闭">
            ✕
          </button>
        </div>
        <div className="spbody">
          {/* 三个面板始终挂载：引擎（DFN 处理器 / 音量应用）不能随面板卸载 */}
          <div style={show('screen')}>
            <ScreenQuality />
          </div>
          <div style={show('noise')}>
            <NoiseControl />
          </div>
          <div style={show('mixer')}>
            <AudioMixer />
          </div>
        </div>
      </div>

      <button type="button" className="spbtn" onClick={() => setOpen((v) => !v)} title="画质 / 降噪 / 音量">
        ⚙ 设置
      </button>

      <style>{`
        .sp{position:relative;display:flex;align-items:center}
        .spbtn{background:#111823;border:1px solid #263140;border-radius:999px;padding:7px 14px;
          font-size:12px;color:#cbd6e2;cursor:pointer;white-space:nowrap}
        .spbtn:hover{background:#182230}
        .spcatch{position:fixed;inset:0;z-index:1100;background:transparent}
        .sppanel{position:fixed;right:12px;bottom:76px;width:324px;max-height:min(70vh,540px);
          overflow:auto;z-index:1101;background:rgba(20,24,31,.97);border:1px solid #2c3441;
          border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.55);color:#d7dde5;
          font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12px}
        .sptabs{display:flex;align-items:center;gap:4px;padding:8px 8px 6px;
          border-bottom:1px solid #262d38;position:sticky;top:0;background:rgba(20,24,31,.97)}
        .sptab{flex:1;background:transparent;border:1px solid transparent;border-radius:8px;
          padding:6px 8px;color:#9aa6b4;cursor:pointer;font-size:12px}
        .sptab.on{background:rgba(47,140,255,.16);border-color:#2f8cff;color:#eaf2ff}
        .spx{background:transparent;border:0;color:#8f9aa8;cursor:pointer;font-size:13px;padding:4px 8px}
        .spbody{padding:12px}
        @media (max-width: 560px){
          .sppanel{left:8px;right:8px;width:auto;bottom:70px}
          .spbtn{padding:7px 10px}
        }
      `}</style>
    </div>
  );
}