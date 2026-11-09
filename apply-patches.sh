#!/usr/bin/env bash
# 把本仓库 patches/ 覆盖到上游 livekit-examples/meet 源码上，并补齐 DeepFilterNet3 资源。
#
# 用法：  bash apply-patches.sh <meet 源码目录>
# 这段逻辑和服务器上的 setup.sh 第 2 步等价，改一边记得改另一边。
set -euo pipefail

SRC="${1:?用法: apply-patches.sh <meet 源码目录>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/patches"
ROOM="$SRC/app/rooms/[roomName]"

[ -d "$SRC/app" ] || { echo "错误：$SRC 不像 meet 源码目录"; exit 1; }
[ -d "$ROOM" ] || { echo "错误：$ROOM 不存在，上游可能改了文件结构"; exit 1; }

# 注意：MicGain.ts / GainProcessor.ts 是**新增**文件，上游仓库里没有。
# 漏拷会在 pnpm build 时报 Module not found: Can't resolve './MicGain'。
ROOM_FILES=(
  PageClientImpl.tsx page.tsx AudioMixer.tsx ScreenQuality.tsx
  NoiseControl.tsx DfnProcessor.ts RoomLayout.tsx SettingsPanel.tsx
  ShareConfig.ts MicIntent.ts MicWatchdog.tsx Chime.ts
  MicGain.ts GainProcessor.ts
)
ROOT_FILES=(Dockerfile route.ts)

echo "==> 覆盖补丁文件"
cp -f "$P/Dockerfile" "$SRC/Dockerfile"
cp -f "$P/route.ts" "$SRC/app/api/connection-details/route.ts"
for f in "${ROOM_FILES[@]}"; do
  cp -f "$P/$f" "$ROOM/$f"
done

echo "==> 校验补丁完整性"
MISSING=0
for f in "${ROOT_FILES[@]}"; do
  [ -f "$P/$f" ] || { echo "    缺少补丁文件: patches/$f"; MISSING=1; }
done
for f in "${ROOM_FILES[@]}"; do
  if [ ! -f "$P/$f" ]; then
    echo "    缺少补丁文件: patches/$f"; MISSING=1
  elif [ ! -f "$ROOM/$f" ]; then
    echo "    未拷贝到源码: app/rooms/[roomName]/$f"; MISSING=1
  fi
done
if [ "$MISSING" -ne 0 ]; then
  echo "错误：补丁不完整，终止构建（别让 CI 跑到 pnpm build 才报错）"
  exit 1
fi
echo "    已应用 $(( ${#ROOM_FILES[@]} + ${#ROOT_FILES[@]} )) 个文件"

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
