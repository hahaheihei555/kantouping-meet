# kantouping-meet CI

把「看投屏」用的 LiveKit Meet 前端做成镜像，在 **GitHub Actions 免费 runner** 上构建，
小服务器（2C2G）只负责 `docker compose pull`，不再参与编译。

> 为什么需要这个：Next.js 构建要 4 核 + 数 GB 内存。在 2C2G 上直接 `docker compose up --build`
> 会把整机 load 顶到 20 以上，连 sshd 都连不上（2026-11-08 实测踩过）。

---

## 一、一次性准备

### 1. 建 GitHub 仓库

把这个目录（`ci-repo/`）的内容传上去即可。**建议公开**：私有仓库的免费 Actions 只有
2000 分钟/月，公开仓库不限；仓库里没有任何密钥（Secrets 存在 GitHub 设置里，不进 git）。

```
ci-repo/
├─ .github/workflows/build.yml
├─ apply-patches.sh
└─ patches/            ← 16 个文件，服务器上 meet-patches/ 的全部内容
```

> `.github` 是隐藏目录。在网页上传时要**拖整个文件夹**，逐个点选文件会漏掉它，Actions 就不会跑。

### 2. 建 Docker Hub 仓库

- 注册/登录 https://hub.docker.com
- 右上角头像 → **Account settings → Personal access tokens → Generate new token**
  权限选 **Read & Write**，把生成的 token 复制出来（只显示一次）
- **不需要手动建镜像仓库**，第一次 push 会自动建

### 3. 配 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，加两个：

| Name | Value |
|---|---|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | 上一步生成的 token |

---

## 二、构建

推一次代码，或在仓库 Actions 页面点 **Run workflow**。

产出两个 tag：

- `latest`
- `r<构建序号>`（例如 `r12`，**回滚时用这个**）

第一次构建约 3–5 分钟（含拉依赖），之后有缓存约 1–2 分钟。

---

## 三、服务器改成「拉镜像」（一次性）

改 `/root/livekit-deploy/docker-compose.yml` 的 meet 段：

```yaml
  meet:
-   build: ./meet
+   image: ${MEET_IMAGE:-docker.io/你的DockerHub用户名/kantouping-meet:latest}
    restart: unless-stopped
    network_mode: host
    environment:
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      ...
```

`/root/livekit-deploy/.env` 里加一行（方便以后只改 tag 回滚）：

```bash
MEET_IMAGE=docker.io/你的DockerHub用户名/kantouping-meet:latest
```

> 镜像里**没有任何密钥**：`LIVEKIT_API_SECRET` 等全部来自服务器上的 `.env`，运行时注入。
> 所以镜像公开也不会泄露密钥。

首次拉取（约 1GB，之后只拉变化的层）：

```bash
cd /root/livekit-deploy
docker compose pull meet
docker compose up -d meet
```

---

## 四、以后每次部署（约 30 秒，不会把机器打瘫）

```bash
# 1) 等 GitHub Actions 构建完，然后：
cd /root/livekit-deploy
docker compose pull meet      # 只下载变化的层
docker compose up -d meet     # 容器重建，房间断约 10 秒
```

就这两条，**不再需要 `--build`**。

部署成功后清一次旧镜像（每个约 1GB，不清会占满盘）：

```bash
docker image prune -f
```

---

## 五、回滚

```bash
cd /root/livekit-deploy
# 改 .env 里的 tag，例如回到 r11
sed -i 's#kantouping-meet:.*#kantouping-meet:r11#' .env
docker compose pull meet && docker compose up -d meet
```

---

## 六、注意事项

| 事项 | 说明 |
|---|---|
| Docker Hub 限速 | 匿名拉取 100 次/6 小时（按 IP）。我们只在部署时拉，远不会触发 |
| 改代码流程 | 改本地 `livekit-deploy/meet-patches/*` → 同步到本仓库 `patches/` → **同时检查 `apply-patches.sh` 的文件清单** → push → CI 构建 → 服务器 pull |
| 新增文件 | 上游没有的文件（如 `MicGain.ts`、`GainProcessor.ts`）必须写进 `apply-patches.sh` 的 `ROOM_FILES`，否则 `Module not found`。脚本最后有完整性校验，漏了会在「应用补丁」这一步就红，不会等到 build |
| 构建内存 | Dockerfile 用 `ARG NODE_HEAP=4096` 给 CI 用；若真要在小机器上本地构建，加 `--build-arg NODE_HEAP=1024` |
| 上游更新 | `git clone --depth 1` 每次都拿上游最新。上游大改可能让补丁冲突（脚本会因目标目录不存在直接报错），那时固定一个 commit 即可 |
| Git LFS | 上游的背景图走 LFS，workflow 里已经 `git lfs pull`，漏了会构建失败（报 "is not a valid image file"） |
| DeepFilterNet3 | 22MB 的 wasm/模型由 `apply-patches.sh` 在构建时从 npm 下载，不进 git |
| 紧急回退 | `docker-compose.yml` 里的 `build: ./meet` 可以改回去本地构建，但要先把服务器升配 |

---

## 七、常见失败点

| 日志现象 | 原因 / 处理 |
|---|---|
| `Module not found: Can't resolve './MicGain'` | `apply-patches.sh` 漏了新增文件（本版已修） |
| `is not a valid image file` | LFS 没拉下来 |
| `ERR_PNPM_OUTDATED_LOCKFILE` | 上游改了 lockfile，删掉 Dockerfile 里的 `--frozen-lockfile` |
| `cp: cannot stat .../[roomName]` | 上游改了目录结构，补丁要跟着调 |
| `JavaScript heap out of memory` | 堆上限太小，加大 `NODE_HEAP` |
