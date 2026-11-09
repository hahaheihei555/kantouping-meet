#!/usr/bin/env bash
# 把本仓库 patches/ 覆盖到上游 livekit-examples/meet 源码上，并补齐 DeepFilterNet3 资源。
#
# 用法：  bash apply-patches.sh <meet 源码目录>
# 这段逻辑和服务器上的 setup.sh 第 2 步等价，改一边记得改另一边。
#
# 2026-11-09 改成**自动发现**：patches/ 里有几个文件就拷几个，
# 不再手写清单。之前手写清单漏掉新文件（MicGain.ts）导致 CI 必挂，
# 这种错不该再犯第二次。
set -euo pipefail

SRC="${1:?用法: apply-patches.sh <meet 源码目录>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/patches"
ROOM="$SRC/app/rooms/[roomName]"

[ -d "$SRC/app" ] || { echo "错误：$SRC 不像 meet 源码目录"; exit 1; }
[ -d "$ROOM" ] || { echo "错误：$ROOM 不存在，上游可能改了文件结构"; exit 1; }

# 只有这两个文件不在房间目录下，其余一律进 app/rooms/[roomName]/
dest_of() {
  case "$1" in
    Dockerfile) echo "$SRC/Dockerfile" ;;
    route.ts)   echo "$SRC/app/api/connection-details/route.ts" ;;
    *)          echo "$ROOM/$1" ;;
  esac
}

echo "==> 覆盖补丁文件"
COUNT=0
for f in "$P"/*; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  cp -f "$f" "$(dest_of "$base")"
  COUNT=$((COUNT + 1))
done
echo "    已应用 $COUNT 个文件"

echo "==> 校验补丁完整性"
MISSING=0
for f in "$P"/*; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"
  dst="$(dest_of "$base")"
  if [ ! -f "$dst" ]; then
    echo "    未落地: patches/$base -> $dst"
    MISSING=1
  fi
done
if [ "$MISSING" -ne 0 ]; then
  echo "错误：补丁不完整，终止构建（别等 pnpm build 才报错）"
  exit 1
fi

echo "==> 补齐 DeepFilterNet3（wasm + 模型，约 22MB，不进 git）"
DFN="$SRC/public/dfn"
if [ -f "$DFN/assets/deepfilternet/df_bg.wasm" ]; then
  echo "    已存在，跳过"
else
  rm -rf /tmp/ns-pkg /tmp/ns.tgz
  curl -sSL -o /tmp/ns.tgz \
    https://registry.npmjs.org/@workadventure/noise-suppression/-/noise-suppression-0.2.0.tgz
  mkdir -p /tmp/ns-pkg
  tar -xzf /tmp/ns.tgz -C /tmp/ns-pkg
  D=/tmp/ns-pkg/package/dist
  mkdir -p "$DFN/assets/deepfilternet"
  cp -f "$D/deepfilternet.js" "$DFN/"
  cp -f "$D/assets/deepfilternet-worklet-processor.js" "$DFN/assets/"
  cp -f "$D/assets/deepfilternet/df_bg.wasm" "$DFN/assets/deepfilternet/"
  cp -f "$D/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz" "$DFN/assets/deepfilternet/"
  rm -rf /tmp/ns-pkg /tmp/ns.tgz
  echo "    完成：$(du -sh "$DFN" | cut -f1)"
fi

echo "==> 补丁应用完成"
