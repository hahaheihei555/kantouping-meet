# 把官方仓库 clone 到 ./meet 之后，把这个 Dockerfile 放进 meet/ 目录
#   git clone https://github.com/livekit-examples/meet
#   cp Dockerfile meet/
#   然后回到上一级 docker compose build
#
# 注意：这是单阶段构建，镜像约 1GB；ARM 机器上首次构建 3-8 分钟。

FROM node:22-bookworm-slim

WORKDIR /app

# 仓库用 pnpm 管理依赖
RUN corepack enable

# 先装依赖，利用 Docker 层缓存
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 再拷源码并构建
COPY . .

# 构建堆上限：CI（GitHub runner，4C16G）用默认 4096；
# 如果一定要在 2C2G 小机器上本地构建，加 --build-arg NODE_HEAP=1024。
# 坑：堆上限设得比物理内存还大（如在 2G 机器上用 4096）会让 V8 一直往 swap 里长，
# 整机进入 swap 抖动，连 sshd 都响应不了（实测卡死 20 分钟）。
ARG NODE_HEAP=4096
ENV NODE_OPTIONS=--max-old-space-size=${NODE_HEAP}
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "start"]
