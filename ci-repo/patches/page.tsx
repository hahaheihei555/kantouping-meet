import * as React from 'react';
import { PageClientImpl } from './PageClientImpl';
import { isVideoCodec } from '@/lib/types';
import { getLiveKitURL } from '@/lib/getLiveKitURL';

// 【关键默认值】原版这里写的是 'vp9'。
// 后果：URL 不带 ?codec= 时，props.options.codec 永远是 'vp9'（真值），
// PageClientImpl 里那个“默认 h264”的分支根本走不到 —— 等于白改。
// VP9 是纯软件编码，1080p30 能吃掉 4-8 个核，一边游戏一边投屏必然掉帧、
// 并被浏览器缩小成几百像素宽（实测 393×243、上行只有 1.2 Mbps）。
// 这里改成一进房就用 H.264（显卡硬编），想用别的编码仍可通过 ?codec= 覆盖。
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ roomName: string }>;
  searchParams: Promise<{
    // FIXME: We should not allow values for regions if in playground mode.
    region?: string;
    hq?: string;
    codec?: string;
    singlePC?: string;
  }>;
}) {
  const _params = await params;
  const _searchParams = await searchParams;
  const codec =
    typeof _searchParams.codec === 'string' && isVideoCodec(_searchParams.codec)
      ? _searchParams.codec
      : 'h264';
  const hq = _searchParams.hq === 'true' ? true : false;
  const singlePC = _searchParams.singlePC !== 'false';
  const serverUrl = process.env.LIVEKIT_URL
    ? getLiveKitURL(process.env.LIVEKIT_URL, _searchParams.region ?? null)
    : undefined;

  return (
    <PageClientImpl
      roomName={_params.roomName}
      serverUrl={serverUrl}
      region={_searchParams.region}
      hq={hq}
      codec={codec}
      singlePeerConnection={singlePC}
    />
  );
}
