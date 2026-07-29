# 优胜美设备管理系统：正式上云 Docker 部署执行手册

> 文档版本：V1.0  
> 编制日期：2026-07-28  
> 适用项目：`生产设备系统管理-安卓手机测试版/equipment-system`  
> 目标环境：中国大陆云服务器、公司已备案域名、50～200 个账号、约 30 人并发  
> 目标架构：Docker Compose + Node.js 24 + Caddy 自动 HTTPS + SQLite 单实例

---

## 0. 使用说明

这是一份从“购买服务器”到“正式上线、备份、更新和回滚”的执行手册。请严格按阶段顺序执行，不要跳过备份、验收和回滚演练。

文中命令按执行位置分为：

- **[本地电脑]**：当前开发电脑或公司构建机；
- **[云控制台]**：云厂商网页控制台；
- **[云服务器]**：通过 SSH 登录后的 Ubuntu 服务器；
- **[正式手机]**：准备安装正式 APK 的 Android 手机。

所有尖括号内容都是占位符，执行前必须替换，例如：

```text
<正式子域名>          例如 equipment.example.com
<云服务器公网IP>
<私有镜像仓库地址>
<对象存储桶名称>
<运维邮箱>
```

禁止把以下内容写进 Git、本文档或聊天记录：

- 云服务器密码、SSH 私钥；
- 私有镜像仓库密码；
- 对象存储密钥；
- Android 正式签名文件及密码；
- 生产数据库、员工账号、现场照片；
- 会话 Cookie 或其他访问令牌。

### 0.1 最终架构

```text
手机浏览器 / 正式 Android App
              │
              │ HTTPS :443
              ▼
┌───────────────────────────────┐
│ 云服务器                      │
│                               │
│  Caddy 容器                   │
│  - 自动申请/续期 HTTPS 证书    │
│  - HTTP 跳转 HTTPS             │
│  - 安全响应头                  │
│            │ Docker 内部网络   │
│            ▼                  │
│  App 容器                     │
│  - Node.js 24                 │
│  - 项目代码和 npm 依赖         │
│  - 只启动 1 个副本             │
│            │                  │
│            ▼                  │
│  /srv/ysm/data                │
│  - equipment.db               │
│  - attachments/               │
│                               │
│  /srv/ysm/backups             │
│  - 本地备份                    │
└──────────────┬────────────────┘
               │ 加密上传
               ▼
        私有对象存储 / 云盘快照
```

### 0.2 关键原则

1. Docker 镜像只包含代码和依赖，**绝不包含数据库、照片、密码或签名文件**。
2. SQLite 数据库和附件持久化在宿主机 `/srv/ysm/data`。
3. SQLite 只能由一个 App 容器写入，生产环境 `app` 副本数固定为 1。
4. App 的 8787 端口只在 Docker 内部网络可见，不发布到公网。
5. 服务器只需安装 Docker Engine、Compose 插件和基本系统工具，不单独安装 Node.js、npm、Nginx、Certbot。
6. 正式上线前必须完成公网安全加固、数据清理、备份恢复演练和三角色验收。

---

## 1. 上线参数登记表

购买资源后先填写此表。未填完不得执行正式切换。

| 项目 | 待填写值 | 核对人 |
|---|---|---|
| 云厂商 | `<云厂商>` |  |
| 企业云账号 | `<公司实名账号>` |  |
| 服务器地域 | `<中国大陆地域>` |  |
| 服务器实例 ID | `<实例ID>` |  |
| 公网 IPv4 | `<公网IP>` |  |
| 正式子域名 | `<正式子域名>` |  |
| ICP 备案号 | `<ICP备案号>` |  |
| 当前备案接入商 | `<接入商>` |  |
| APP 备案号 | `<APP备案号/待办理>` |  |
| 公安备案号 | `<上线后30日内办理>` |  |
| 私有镜像仓库 | `<仓库地址>` |  |
| 对象存储桶 | `<私有存储桶>` |  |
| 运维负责人 | `<姓名和联系方式>` |  |
| 业务验收负责人 | `<姓名和联系方式>` |  |
| 首次上线时间 | `<日期和维护窗口>` |  |
| 回滚决定人 | `<姓名>` |  |

---

## 2. 阶段一：程序生产化与 Docker 化

> 执行位置：**[本地电脑]**  
> 当前项目可以在 Node.js 22.23.1 下通过全部 17 个测试文件，但生产镜像计划使用 Node.js 24 LTS。  
> 本阶段完成前，不得把当前测试版直接暴露到公网。

### 2.1 上线前必须完成的安全改造

- [x] 登录失败记录持久化，不能只存内存。
- [x] 同一账号连续失败 5 次后锁定 15 分钟。
- [x] 同一来源 IP 异常尝试超过阈值时返回 HTTP 429。
- [x] `POST /api/session` 增加 `LOGIN_RATE_LIMITED` / `ACCOUNT_LOCKED` 错误码。
- [x] 密码最低长度由 8 位提高到 12 位。
- [ ] 生产管理员使用 16 位以上独立密码。
- [x] 校验请求 `Host`，只接受正式域名（本机健康探针例外）。
- [x] 当请求包含 `Origin` 时，拒绝与正式域名不一致的写请求。
- [x] 只在 `YSM_TRUST_PROXY=1` 的单入口部署中读取 Caddy 转发头。
- [x] 记录登录成功、登录失败、账号锁定和来源限流。
- [x] 日志不得记录密码、会话 Token、Cookie 和照片内容。
- [x] 首页和 App 远程页面预留公司名称、隐私规则、备案号与联系方式。
- [ ] 建立至少两个三级管理员，完成改密后停用默认 `admin` 账号。

建议新增环境变量：

```ini
YSM_TRUSTED_ORIGIN=https://<正式子域名>
YSM_LOGIN_MAX_FAILURES=5
YSM_LOGIN_LOCK_MINUTES=15
```

> 当前代码已读取并测试上述变量；仍需在正式 `.env.production` 填入真实域名、备案信息，并完成双管理员现场操作。

### 2.2 Dockerfile 模板

在仓库根目录新增 `equipment-system/Dockerfile`：

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY web ./web
COPY scripts/backup-production.js ./scripts/backup-production.js
COPY scripts/verify-backup.js ./scripts/verify-backup.js
COPY scripts/restore-production.js ./scripts/restore-production.js

RUN chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
```

检查项：

- [ ] 使用 Node.js 24 LTS 官方镜像。
- [ ] 使用 `npm ci --omit=dev`。
- [ ] 最终容器使用 `node` 非 root 用户。
- [ ] 没有复制 `data/`、APK、签名文件和本地日志。
- [ ] 容器收到 SIGTERM 时，当前 `server.js` 能关闭 HTTP 服务和数据库。

### 2.3 `.dockerignore` 模板

在仓库根目录新增 `equipment-system/.dockerignore`：

```dockerignore
.git
.gitignore
node_modules
npm-debug.log*
data
coverage
.nyc_output
mobile
test
资料整理
安装包
web/downloads
*.apk
*.db
*.db-wal
*.db-shm
*.log
*.pid
*.bak
*.tmp
.DS_Store
Thumbs.db
```

### 2.4 生产 Compose 模板

在仓库根目录新增 `compose.production.yaml`：

```yaml
name: ysm-equipment-system

services:
  app:
    image: ${APP_IMAGE:?APP_IMAGE is required}
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "8787"
      YSM_DB_PATH: /data/equipment.db
      PUBLIC_BASE_URL: https://${DOMAIN}
      YSM_SECURE_COOKIE: "1"
      YSM_TRUSTED_ORIGIN: https://${DOMAIN}
      YSM_LOGIN_MAX_FAILURES: "5"
      YSM_LOGIN_LOCK_MINUTES: "15"
    expose:
      - "8787"
    volumes:
      - type: bind
        source: /srv/ysm/data
        target: /data
    networks:
      - backend
    restart: unless-stopped
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    stop_grace_period: 30s
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:8787/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    mem_limit: 6g
    cpus: 3.0
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"

  backup:
    profiles:
      - ops
    image: ${APP_IMAGE:?APP_IMAGE is required}
    command:
      - node
      - scripts/backup-production.js
      - /backups
    environment:
      NODE_ENV: production
      YSM_DB_PATH: /data/equipment.db
      YSM_BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-30}
    volumes:
      - type: bind
        source: /srv/ysm/data
        target: /data
      - type: bind
        source: /srv/ysm/backups
        target: /backups
    network_mode: none
    restart: "no"
    init: true
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    mem_limit: 2g
    cpus: 1.0
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"

  caddy:
    image: ${CADDY_IMAGE:?CADDY_IMAGE is required}
    environment:
      DOMAIN: ${DOMAIN:?DOMAIN is required}
      ACME_EMAIL: ${ACME_EMAIL:?ACME_EMAIL is required}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - type: bind
        source: /srv/ysm/deploy/Caddyfile
        target: /etc/caddy/Caddyfile
        read_only: true
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - edge
      - backend
    depends_on:
      app:
        condition: service_healthy
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "5"

networks:
  edge:
  backend:
    internal: true

volumes:
  caddy_data:
  caddy_config:
```

重要核对：

- [ ] `app` 没有 `ports:`，因此 8787 不会发布到宿主机。
- [ ] `app` 只连接 `backend` 内部网络。
- [ ] `caddy` 同时连接公网边缘网络和内部网络。
- [ ] `app` 固定一个副本，没有 `deploy.replicas`。
- [ ] 数据使用 `/srv/ysm/data` 绑定挂载。
- [ ] `backup` 默认不常驻，只在手工或定时任务中运行。
- [ ] `backup` 没有网络权限，只能读取数据并写入本地备份目录。
- [ ] Caddy 证书使用命名卷持久化。
- [ ] 没有把 `/var/run/docker.sock` 挂进任何容器。

### 2.5 Caddyfile 模板

创建 `/srv/ysm/deploy/Caddyfile` 时使用：

```caddyfile
{
	email {$ACME_EMAIL}
	admin off
}

{$DOMAIN} {
	encode zstd gzip

	request_body {
		max_size 12MB
	}

	header {
		-Server
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "same-origin"
		Permissions-Policy "camera=(self), microphone=(), geolocation=()"
		Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'none'"
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
	}

	reverse_proxy app:8787 {
		health_uri /api/health
		health_interval 30s
		health_timeout 5s
	}

	log {
		output stdout
		format json
	}
}
```

> 首次调试 HTTPS 时可暂时不启用 HSTS。确认域名和证书完全正确后再加入 `Strict-Transport-Security`，避免错误配置被浏览器长期记住。

### 2.6 生产环境变量模板

服务器创建 `/srv/ysm/deploy/.env`：

```ini
DOMAIN=<正式子域名>
ACME_EMAIL=<运维邮箱>
APP_IMAGE=<私有镜像仓库>/ysm-equipment-system@sha256:<应用镜像摘要>
CADDY_IMAGE=<私有镜像仓库>/caddy@sha256:<Caddy镜像摘要>
```

设置权限：

```bash
sudo chown root:root /srv/ysm/deploy/.env
sudo chmod 600 /srv/ysm/deploy/.env
```

### 2.7 本地构建验证

```bash
cd "/home/boki/桌面/生产设备系统管理-安卓手机测试版/equipment-system"

npm ci
npm test

docker build \
  --platform linux/amd64 \
  --tag ysm-equipment-system:local-test \
  .

docker image inspect ysm-equipment-system:local-test
```

验收：

- [ ] `npm test` 全部通过。
- [ ] 镜像内不存在 `/app/data` 的生产数据库。
- [ ] 镜像内不存在 APK、Android 签名和 `node_modules` 开发依赖。
- [ ] 容器进程用户不是 root。
- [ ] 使用临时数据目录启动后 `/api/health` 返回 200。
- [ ] 删除并重建容器后，挂载目录内的数据仍然存在。

---

## 3. 阶段二：购买云资源

> 执行位置：**[云控制台]**

### 3.1 云账号

- [ ] 使用公司实名认证的企业云账号购买。
- [ ] 不使用员工个人实名账号。
- [ ] 云账号开启多因素验证。
- [ ] 财务、运维、备案人员使用独立子账号和最小权限。
- [ ] 域名持有人、云账号主体、ICP备案主体与公司信息一致。

> “设备系统管理员暂不启用 TOTP”不等于云控制台可以不启用多因素验证。云控制台必须启用。

### 3.2 推荐服务器配置

| 项目 | 推荐值 |
|---|---|
| 地域 | 距工厂较近、支持当前备案的中国大陆地域 |
| 操作系统 | Ubuntu Server 24.04 LTS x86_64 |
| CPU / 内存 | 4 核 / 8GB |
| 系统盘 | SSD 40～60GB |
| 数据盘 | SSD 100GB，独立于系统盘 |
| 公网 | 固定公网 IPv4 |
| 带宽 | 10Mbps 起步，按监控调整 |
| 购买周期 | 至少一年，并满足接入商备案资源要求 |
| 快照 | 每日自动数据盘快照 |
| 对象存储 | 私有桶、服务端加密、禁止匿名访问 |

暂不购买：

- CDN；
- 负载均衡；
- 云数据库；
- Kubernetes；
- 多台应用服务器。

原因：当前是单实例 SQLite，不能安全地让多个容器同时写同一个数据库。

### 3.3 安全组

| 协议 | 端口 | 来源 | 用途 |
|---|---:|---|---|
| TCP | 22 | 公司/运维固定 IP | SSH |
| TCP | 80 | `0.0.0.0/0` | HTTPS 跳转和证书验证 |
| TCP | 443 | `0.0.0.0/0` | 正式访问 |
| UDP | 443 | `0.0.0.0/0` | HTTP/3，可选 |

- [ ] 不开放 8787。
- [ ] 不开放任何 SQLite 或数据库端口。
- [ ] 不开放 Docker API 2375/2376。
- [ ] SSH 禁止全网长期开放。

---

## 4. 阶段三：备案、域名和合规核对

> 执行位置：**[云控制台]**

### 4.1 ICP 备案

1. 登录工信部备案系统查询公司主体、主域名、备案号和接入商。
2. 登录当前备案接入商控制台，输入主域名。
3. 让接入商系统判断属于：
   - 已可接入；
   - 新增网站/服务；
   - 变更备案；
   - 接入备案。
4. 管局或接入商未确认前，不要把生产系统公开上线。
5. 网站首页底部显示备案号并链接：

```text
https://beian.miit.gov.cn/
```

工信部要求在中国境内提供非经营性互联网信息服务时履行备案，并在主页底部标明备案编号：[非经营性互联网信息服务备案管理办法](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)。

### 4.2 APP 备案

- [ ] 正式 APP 名称确定。
- [ ] 正式 Android 包名确定。
- [ ] 公司正式签名确定。
- [ ] 正式服务域名确定。
- [ ] 主办单位为公司。
- [ ] 隐私规则和联系方式准备完成。
- [ ] 在接入商控制台提交 APP 备案。
- [ ] APP 显著位置显示备案号。

即使 APK 只通过公司内部渠道发放，也应让接入商明确是否需要 APP 备案，不得把“没有上应用商店”等同于“不需要备案”。工信部 APP 备案通知见：[工业和信息化部关于开展移动互联网应用程序备案工作的通知](https://www.gov.cn/zhengce/zhengceku/202308/content_6897341.htm?type=mobile-internet)。

### 4.3 其他合规事项

- [ ] 网站上线后 30 日内办理公安联网备案。
- [ ] 首页显示公安备案号及查询链接。
- [ ] 让公司 IT/合规人员判断是否需要网络安全等级保护定级。
- [ ] 员工个人信息告知写明：
  - 处理者名称和联系方式；
  - 姓名、工号、手机号、维修照片、操作日志的用途；
  - 保存期限；
  - 查询、更正和投诉方式。
- [ ] 不接入未经批准的境外统计、崩溃上报或推送服务。

个人信息应限定在实现业务目的的最小范围，参考：[中华人民共和国个人信息保护法](https://www.npc.gov.cn/WZWSREL25wYy9jMi9jMzA4MzQvMjAyMTA4L3QyMDIxMDgyMF8zMTMwODguaHRtbD9yZWY9aW1i)。

---

## 5. 阶段四：建立私有镜像仓库

> 执行位置：**[云控制台] + [本地电脑]**

### 5.1 仓库设置

- [ ] 在公司云账号下创建企业私有镜像仓库。
- [ ] 仓库禁止匿名拉取。
- [ ] 本地构建账号具有推送权限。
- [ ] 云服务器账号只有拉取权限。
- [ ] 开启镜像漏洞扫描。
- [ ] 同时把 Caddy 官方镜像同步到同一私有仓库，避免生产服务器直接拉取 Docker Hub。

### 5.2 构建并推送应用镜像

以下变量仅用于说明，替换后执行：

```bash
export YSM_REGISTRY="<私有镜像仓库地址>"
export YSM_VERSION="1.0.0-<Git短提交号>"

docker login "$YSM_REGISTRY"

docker buildx build \
  --platform linux/amd64 \
  --tag "$YSM_REGISTRY/ysm-equipment-system:$YSM_VERSION" \
  --push \
  "/home/boki/桌面/生产设备系统管理-安卓手机测试版/equipment-system"
```

获取并记录不可变摘要：

```bash
docker buildx imagetools inspect \
  "$YSM_REGISTRY/ysm-equipment-system:$YSM_VERSION"
```

发布规则：

- [ ] 版本标签包含版本号和 Git 提交。
- [ ] 生产 Compose 使用 `@sha256:<摘要>`。
- [ ] 不使用 `latest`。
- [ ] 构建前测试全部通过。
- [ ] 高危漏洞未处理不得发布。

---

## 6. 阶段五：初始化云服务器

> 执行位置：**[云服务器]**

### 6.1 首次 SSH 登录

```bash
ssh <运维账号>@<云服务器公网IP>
```

完成：

- [ ] 更新系统补丁。
- [ ] 使用 SSH 密钥。
- [ ] 禁止 root 密码远程登录。
- [ ] 开启时间同步。
- [ ] 时区设置为 `Asia/Shanghai`。
- [ ] 不把不可信用户加入 `docker` 组，因为 Docker 管理权限近似 root 权限。

```bash
sudo apt update
sudo apt full-upgrade -y
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true
```

### 6.2 挂载数据盘

先在云控制台确认目标数据盘设备名，再执行。**不要照抄设备名格式化未知磁盘。**

安全步骤：

```bash
lsblk -f
sudo blkid
```

确认新数据盘为空、设备名正确后：

```bash
sudo mkfs.ext4 <确认后的数据盘设备>
sudo mkdir -p /srv/ysm
sudo mount <确认后的数据盘设备> /srv/ysm
sudo blkid <确认后的数据盘设备>
```

把真实 UUID 写入 `/etc/fstab`，示例：

```text
UUID=<真实UUID> /srv/ysm ext4 defaults,nofail 0 2
```

验证：

```bash
sudo umount /srv/ysm
sudo mount -a
findmnt /srv/ysm
```

只有 `findmnt` 显示数据盘已正确挂载后才能继续。否则在根盘创建数据目录会导致数据写错位置。

### 6.3 安装 Docker Engine

使用 Docker 官方 APT 仓库，不使用测试用途的一键脚本：

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

创建软件源：

```bash
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

安装：

```bash
sudo apt update
sudo apt install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
sudo docker run --rm hello-world
```

官方安装说明：[Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)。

> Docker 发布端口可能绕过部分 UFW 规则，因此必须同时依赖云安全组，并确保 Compose 不发布 8787、2375、2376。

### 6.4 创建目录和权限

```bash
sudo mkdir -p \
  /srv/ysm/data/attachments \
  /srv/ysm/backups \
  /srv/ysm/deploy

# 官方 Node 镜像内 node 用户通常为 UID/GID 1000。
# 正式镜像构建后仍需用 docker image inspect 核对。
sudo chown -R 1000:1000 /srv/ysm/data
sudo chmod 750 /srv/ysm/data
sudo chmod 750 /srv/ysm/data/attachments

sudo chown -R root:root /srv/ysm/deploy
sudo chmod 750 /srv/ysm/deploy

sudo chown -R root:root /srv/ysm/backups
sudo chmod 700 /srv/ysm/backups
```

### 6.5 上传部署文件

从本地上传：

```bash
scp compose.production.yaml \
  <运维账号>@<云服务器公网IP>:/tmp/

scp Caddyfile \
  <运维账号>@<云服务器公网IP>:/tmp/
```

服务器移动到正式目录：

```bash
sudo install -m 640 -o root -g root \
  /tmp/compose.production.yaml \
  /srv/ysm/deploy/compose.production.yaml

sudo install -m 640 -o root -g root \
  /tmp/Caddyfile \
  /srv/ysm/deploy/Caddyfile
```

创建 `/srv/ysm/deploy/.env`，然后：

```bash
sudo chown root:root /srv/ysm/deploy/.env
sudo chmod 600 /srv/ysm/deploy/.env
```

---

## 7. 阶段六：清理和迁移数据

> 执行位置：**[本地电脑] + [云服务器]**  
> 原数据库当前使用 SQLite WAL 模式。运行中只复制 `equipment.db` 可能漏掉 WAL 内尚未合并的数据。

### 7.1 冻结原系统

- [ ] 通知测试人员停止录入。
- [ ] 记录冻结时间。
- [ ] 停止手机测试服务和电脑本地服务。
- [ ] 确认没有 Node 进程继续写数据库。
- [ ] 原始数据目录先制作一份只读备份。

原始数据位置：

```text
equipment-system/data/equipment.db
equipment-system/data/equipment.db-wal
equipment-system/data/equipment.db-shm
equipment-system/data/attachments/
```

### 7.2 清理原则

生产数据库采用“从原库复制到新库”的白名单方式，不在唯一原库上直接执行大量删除。

默认保留：

- 工厂、车间、产线、工序、机位；
- 正式设备类型；
- 正式设备台账；
- 设备永久编码和编码流水；
- 当前有效安装关系；
- 已确认的故障代码；
- 需要继续使用的二维码映射。

默认不迁移：

- 测试会话；
- 测试工单和工单历史；
- 测试评价；
- 测试巡检；
- 测试照片；
- 测试变动申请；
- 测试审计日志；
- 临时账号和当前密码哈希。

成员处理：

- [ ] 从人事确认名单重新创建。
- [ ] 至少两个三级管理员。
- [ ] 所有人使用一次性初始密码。
- [ ] 首次登录强制修改密码。
- [ ] 不沿用测试账号密码。

设备编码处理：

- [ ] 已发放的永久设备编码保持不变。
- [ ] 编码流水必须不小于现有最大编号。
- [ ] 导入后检查不存在重复设备编码。
- [ ] 旧二维码若包含局域网地址，正式上线后重新打印。

### 7.3 一致性备份

使用 SQLite Online Backup、`.backup` 或 `VACUUM INTO` 生成一致性快照，参考：[SQLite Backup API](https://www.sqlite.org/backup.html)。

完成后检查：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

成功标准：

```text
integrity_check 返回 ok
foreign_key_check 无结果
```

为迁移文件生成校验：

```bash
sha256sum equipment-production.db > equipment-production.db.sha256
tar -czf attachments-production.tar.gz attachments/
sha256sum attachments-production.tar.gz > attachments-production.tar.gz.sha256
```

### 7.4 上传生产数据

```bash
scp equipment-production.db \
  equipment-production.db.sha256 \
  attachments-production.tar.gz \
  attachments-production.tar.gz.sha256 \
  <运维账号>@<云服务器公网IP>:/tmp/
```

服务器验证：

```bash
cd /tmp
sha256sum -c equipment-production.db.sha256
sha256sum -c attachments-production.tar.gz.sha256
```

确认无误后，且 App 容器尚未启动：

```bash
sudo install -m 640 -o 1000 -g 1000 \
  /tmp/equipment-production.db \
  /srv/ysm/data/equipment.db

sudo tar -xzf /tmp/attachments-production.tar.gz \
  -C /srv/ysm/data

sudo chown -R 1000:1000 /srv/ysm/data
sudo find /srv/ysm/data -type d -exec chmod 750 {} \;
sudo find /srv/ysm/data -type f -exec chmod 640 {} \;
```

迁移验收记录：

| 数据 | 原系统确认数 | 生产库确认数 | 结果 |
|---|---:|---:|---|
| 车间 |  |  |  |
| 产线 |  |  |  |
| 工序 |  |  |  |
| 机位 |  |  |  |
| 设备 |  |  |  |
| 当前安装关系 |  |  |  |
| 故障代码 |  |  |  |
| 正式成员 |  |  |  |

---

## 8. 阶段七：首次启动 Docker 服务

> 执行位置：**[云服务器]**

### 8.1 登录私有镜像仓库

```bash
sudo docker login <私有镜像仓库地址>
```

只使用具有拉取权限的生产凭据。

### 8.2 配置检查

```bash
cd /srv/ysm/deploy

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  config
```

重点检查输出：

- [ ] 正式域名正确。
- [ ] `PUBLIC_BASE_URL` 是 `https://<正式子域名>`。
- [ ] `YSM_DB_PATH` 是 `/data/equipment.db`。
- [ ] App 镜像和 Caddy 镜像均包含固定 SHA-256 摘要。
- [ ] App 没有宿主机端口映射。
- [ ] 没有明文密码或存储密钥。

### 8.3 拉取镜像

```bash
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  pull
```

### 8.4 先启动 App

```bash
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  up -d app

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  ps

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  logs --tail=200 app
```

成功标准：

- `app` 状态为 `healthy`；
- 日志没有数据库权限错误；
- 没有 `SQLITE_BUSY`；
- 没有迁移失败；
- 数据库和附件仍位于 `/srv/ysm/data`。

从 Docker 内部验证：

```bash
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  exec app \
  node -e "fetch('http://127.0.0.1:8787/api/health').then(async r=>{console.log(r.status,await r.text())})"
```

### 8.5 域名解析

在备案条件允许后：

1. 在域名控制台新增 A 记录；
2. 主机记录填写正式子域名前缀，例如 `equipment`；
3. 记录值填写服务器固定公网 IP；
4. TTL 首次上线前设为 300 秒；
5. 等待公网解析生效。

验证：

```bash
dig +short <正式子域名>
```

结果应为云服务器公网 IP。

### 8.6 启动 Caddy

```bash
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  up -d caddy

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  ps

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  logs --tail=200 caddy
```

Caddy 自动 HTTPS 的必要条件：

- 域名 A/AAAA 记录指向本服务器；
- 80、443 可从公网访问；
- Caddy 能绑定端口；
- `caddy_data` 卷可持久写入；
- 云服务器可访问公网 ACME 服务。

官方说明：[Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)。

验证：

```bash
curl -I http://<正式子域名>
curl -I https://<正式子域名>
curl -sS https://<正式子域名>/api/health
```

成功标准：

- HTTP 自动跳转 HTTPS；
- HTTPS 证书域名正确且受信任；
- `/api/health` 返回成功；
- 浏览器没有证书警告。

### 8.7 公网端口检查

从云服务器以外的电脑测试：

```bash
curl -I https://<正式子域名>
curl --max-time 5 http://<云服务器公网IP>:8787
```

第二条必须连接失败或超时。若8787能访问，立即停止上线并检查：

- Compose 是否错误增加了 `ports: 8787:8787`；
- 云安全组是否开放8787；
- 是否残留本机直接运行的 Node 服务。

---

## 9. 阶段八：备份和恢复

### 9.1 备份目标

| 指标 | 目标 |
|---|---|
| RPO | 最多丢失 1 小时数据 |
| RTO | 4 小时内恢复 |
| 小时备份 | 保留 24 份 |
| 日备份 | 保留 30 份 |
| 月备份 | 保留 12 份 |
| 恢复演练 | 每月至少 1 次 |

### 9.2 备份内容

必须同时包含：

- 一致性的 `equipment.db`；
- 数据库快照中引用的 `attachments/` 文件；
- 备份时间、应用版本和镜像摘要；
- SHA-256 校验文件；
- 数据库完整性检查结果；
- 恢复说明。

不能只备份：

- 单独的 `equipment.db`；
- Docker 容器；
- Docker 镜像；
- Git 仓库；
- 云盘快照中的某一个目录。

### 9.3 备份执行方式

在应用镜像中加入 `scripts/backup-production.js`，通过 Node.js 内置 SQLite API执行：

1. 使用 `VACUUM INTO` 或 Online Backup 生成一致性数据库；
2. 对备份数据库执行 `PRAGMA integrity_check`；
3. 将当前附件目录完整归档；
4. 把数据库和附件归档放入同一备份目录；
5. 生成清单和校验值；
6. 写入 `/backups/ysm-backup-<时间戳>/`；
7. 失败时删除不完整备份并返回非零退出码。

生产 Compose 中的 `backup` 服务只在手工或定时任务中运行：

```bash
cd /srv/ysm/deploy

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  run --rm backup
```

宿主机使用 systemd timer 定时调用 Docker 命令，不在 App 容器中运行 cron。

计划：

- 每小时：数据库一致性备份；
- 每日凌晨：数据库和全部附件完整备份；
- 每日：数据盘云快照；
- 备份完成后：加密上传私有对象存储；
- 对象存储：禁止匿名访问，开启版本控制和生命周期规则。

### 9.4 恢复演练

恢复不能覆盖当前生产数据。使用临时目录：

```text
/srv/ysm/restore-test/<日期>/
```

演练步骤：

- [ ] 下载指定备份。
- [ ] 验证 SHA-256。
- [ ] 解密并解压。
- [ ] 对数据库执行完整性检查。
- [ ] 使用独立 Compose 项目名和独立端口启动临时系统。
- [ ] 管理员登录。
- [ ] 随机打开 10 张照片。
- [ ] 随机检查 10 台设备和 10 张工单。
- [ ] 记录恢复用时。
- [ ] 演练结束后删除临时容器和临时数据。

---

## 10. 阶段九：正式 Android APK

> 执行位置：**[本地电脑] + [正式手机]**

当前脚本构建的是局域网 Debug 测试包，必须重新制作生产版。

### 10.1 正式包改造

- [ ] 包名从 `com.ysm.equipment.mobiletest` 改为公司正式包名。
- [ ] 应用名称去掉“测试”。
- [ ] `server.url` 改为 `https://<正式子域名>`。
- [ ] `cleartext` 关闭或设为 `false`。
- [ ] Debug 日志关闭。
- [ ] 使用 `assembleRelease`，不能继续使用 `assembleDebug`。
- [ ] `versionName` 从 `1.0.0` 开始。
- [ ] `versionCode` 每次发布递增。
- [ ] APP 内显示公司、隐私规则、版本号和 APP 备案号。

### 10.2 正式签名

- [ ] 由公司生成正式签名密钥。
- [ ] 密钥不放在仓库目录。
- [ ] 密钥密码不写入 Gradle 文件或脚本。
- [ ] 签名材料至少保留两份：公司密码管理系统和离线加密介质。
- [ ] 明确密钥保管人和恢复流程。
- [ ] 使用 `apksigner verify --verbose` 验证。
- [ ] 生成 APK SHA-256。

现有 Debug 测试包不能直接被正式签名包覆盖：

- 使用新正式包名可与测试版并存；或
- 先卸载测试版，再安装正式版。

### 10.3 内部分发

正式 APK 不放到公开的 `equipment-system/web/downloads/`。

采用：

- 企业微信；
- 公司内部门户；
- 私有对象存储的短期签名下载链接；
- 受控的公司设备管理平台。

分发页面包含：

- 版本号；
- 发布日期；
- SHA-256；
- 更新内容；
- 最低 Android 版本；
- 安装说明；
- 公司联系方式。

---

## 11. 阶段十：上线验收

### 11.1 基础测试

- [ ] Node.js 24 容器内自动化测试全部通过。
- [ ] App 容器健康。
- [ ] Caddy 容器健康。
- [ ] HTTPS 证书正确。
- [ ] HTTP 自动跳转 HTTPS。
- [ ] 8787 公网不可访问。
- [ ] Cookie 包含 `Secure`、`HttpOnly`、`SameSite=Lax`。
- [ ] 安全响应头存在。
- [ ] 默认管理员已经完成改密或停用。
- [ ] 至少两个正式三级管理员。

### 11.2 三角色业务测试

普工：

- [ ] 登录和首次改密；
- [ ] 扫码报修；
- [ ] 拍照上传；
- [ ] 查看自己的工单；
- [ ] 到场前撤回；
- [ ] 工单评价；
- [ ] 无法看到他人受限数据。

技术员：

- [ ] 待接单池；
- [ ] 接单、到场、维修、试运行、结单；
- [ ] 故障分类；
- [ ] 修正实际设备；
- [ ] 添加零件；
- [ ] 巡检和转工单；
- [ ] 只能推进自己接的工单。

管理员：

- [ ] 成员管理；
- [ ] 指派和转派工单；
- [ ] 设备台账；
- [ ] 产线组合和变动审核；
- [ ] 故障代码；
- [ ] 服务评价；
- [ ] 审计日志；
- [ ] 最后一个管理员不能被停用。

通用：

- [ ] Excel 模板下载；
- [ ] Excel 预览和导入；
- [ ] 附件权限；
- [ ] 设备履历；
- [ ] 正式二维码地址；
- [ ] 手机浏览器和正式 APK 均可使用。

### 11.3 安全测试

- [ ] 错误密码达到阈值后锁定。
- [ ] 锁定返回 429 和统一错误信息。
- [ ] 停用成员后旧会话立即失效。
- [ ] 修改级别后旧会话立即失效。
- [ ] 普工无法调用管理员写接口。
- [ ] 伪造角色请求头无效。
- [ ] 伪造 `X-Forwarded-*` 不能改变可信来源。
- [ ] 非正式域名 Host 被拒绝。
- [ ] 跨站 Origin 写请求被拒绝。
- [ ] 日志中没有密码、Cookie 和 Token。

### 11.4 并发压测

目标场景：

- 30 人同时在线；
- 5 人同时上传照片；
- 混合执行列表查询、扫码解析、报修、接单和状态推进。

通过标准：

- HTTP 5xx 为 0；
- `SQLITE_BUSY` 为 0；
- 普通 API P95 小于 1.5 秒；
- 照片上传在测试网络条件下无超时；
- App 容器内存不持续增长；
- WAL 文件不会无限增长；
- CPU 不持续超过 70%；
- 数据盘使用率低于 70%。

若不通过：

1. 暂停正式上线；
2. 先排查慢查询、长事务、照片大小和 WAL checkpoint；
3. 仍无法达到目标时迁移 PostgreSQL；
4. 不允许简单增加 App 容器数量来解决 SQLite 写入瓶颈。

---

## 12. 阶段十一：正式切换

### 12.1 上线前一天

- [ ] DNS TTL 调整为 300 秒。
- [ ] 发布版本、Git提交和镜像摘要冻结。
- [ ] 备案状态确认。
- [ ] 正式管理员和试点成员准备完成。
- [ ] 完整备份成功。
- [ ] 回滚镜像和回滚数据库准备完成。
- [ ] 维护窗口和联系人通知完成。

### 12.2 上线当天

1. 停止测试系统写入。
2. 制作最终迁移快照。
3. 上传并核对校验值。
4. 启动 App 容器。
5. 确认健康检查。
6. 启动 Caddy。
7. 确认 HTTPS。
8. 三角色冒烟测试。
9. 6 名试点员工使用 1～3 天。
10. 观察无严重问题后全员开放网页版。
11. 分发正式 APK。
12. 重新生成并抽样测试正式二维码。
13. 再批量打印设备铭牌。

### 12.3 上线后观察

上线后 24 小时重点观察：

- 容器重启次数；
- HTTP 5xx；
- 登录失败和锁定次数；
- CPU、内存、磁盘；
- SQLite 锁错误；
- WAL 文件大小；
- 图片上传失败；
- 备份任务；
- HTTPS 证书；
- 员工反馈。

旧电脑：

- 保留只读原始备份至少 90 天；
- 不再允许继续产生正式工单；
- 不作为生产系统热备；
- 数据恢复前必须重新核对版本和完整性。

---

## 13. 更新和回滚

### 13.1 标准更新流程

每次更新必须使用固定镜像摘要。

```bash
cd /srv/ysm/deploy

# 1. 查看当前版本
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  images

# 2. 执行上线前备份
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  run --rm backup

# 3. 修改 .env 中 APP_IMAGE 为新摘要
sudoedit /srv/ysm/deploy/.env

# 4. 验证配置
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  config

# 5. 拉取镜像
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  pull app

# 6. 重建 App，不重建 Caddy
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  up -d --no-deps app

# 7. 检查
sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  ps

sudo docker compose \
  --env-file .env \
  -f compose.production.yaml \
  logs --tail=200 app
```

### 13.2 回滚原则

无数据库结构变化：

1. 把 `.env` 中 `APP_IMAGE` 改回旧摘要；
2. `docker compose pull app`；
3. `docker compose up -d --no-deps app`；
4. 执行健康和冒烟测试。

有数据库结构变化：

1. 停止 App；
2. 保存当前故障现场副本；
3. 恢复升级前数据库和附件；
4. 恢复旧镜像摘要；
5. 启动 App；
6. 执行完整性检查和三角色冒烟测试。

禁止：

- 只回滚代码，不确认数据库兼容性；
- 直接删除生产数据库；
- 使用 `docker compose down -v`；
- 清理未知 Docker 卷；
- 使用 `docker system prune --volumes`；
- 用 `latest` 猜测旧版本。

---

## 14. 日常运维清单

### 每日

- [ ] App 和 Caddy 容器运行正常。
- [ ] 没有持续5xx或数据库锁错误。
- [ ] 备份任务成功。
- [ ] 数据盘使用率正常。
- [ ] 登录异常在合理范围。

### 每周

- [ ] 检查 Docker 和系统安全告警。
- [ ] 抽查备份文件校验。
- [ ] 检查照片和数据库增长。
- [ ] 检查停用员工账号。

### 每月

- [ ] 安排维护窗口更新 Ubuntu 和 Docker。
- [ ] 在测试环境验证新版 Node.js 基础镜像和依赖。
- [ ] 实际恢复一份备份。
- [ ] 检查 HTTPS 证书续期状态。
- [ ] 检查对象存储生命周期规则。
- [ ] 复核管理员账号。
- [ ] 复核运维和镜像仓库权限。

### 告警阈值

| 指标 | 告警条件 |
|---|---|
| 服务可用性 | 连续 2 分钟不可用 |
| CPU | 连续 15 分钟超过 70% |
| 内存 | 超过 80% |
| 数据盘 | 超过 70%预警，80%严重 |
| HTTP 5xx | 5 分钟内持续出现 |
| SQLite | 任意重复 `SQLITE_BUSY` |
| 备份 | 超过 2 小时没有新小时备份 |
| 证书 | 剩余有效期少于 21 天 |
| WAL | 持续增长且无法 checkpoint |

---

## 15. 常见故障排查

### 15.1 App 容器反复重启

```bash
cd /srv/ysm/deploy
sudo docker compose --env-file .env -f compose.production.yaml ps
sudo docker compose --env-file .env -f compose.production.yaml logs --tail=300 app
sudo ls -la /srv/ysm/data
sudo df -h /srv/ysm
```

重点检查：

- 数据目录 UID/GID；
- 数据盘是否真正挂载；
- 数据库完整性；
- 环境变量；
- 镜像架构；
- 内存不足。

### 15.2 Caddy 无法取得证书

```bash
dig +short <正式子域名>
curl -I http://<正式子域名>
sudo docker compose --env-file .env -f compose.production.yaml logs --tail=300 caddy
```

检查：

- DNS 是否指向本机；
- 80/443 是否开放；
- ICP/接入限制；
- 云服务器出网；
- 域名 CAA 记录；
- Caddy证书卷是否可写；
- ACME 是否触发频率限制。

### 15.3 页面能开但不能登录

检查：

- `YSM_SECURE_COOKIE=1` 时是否确实使用 HTTPS；
- 浏览器 Cookie 是否被拒绝；
- 系统时间是否正确；
- 默认账号是否停用；
- 是否触发登录锁定；
- App 和 Caddy 日志；
- Host/Origin 白名单是否写错。

### 15.4 照片上传失败

检查：

- 请求是否超过12MB；
- 单张是否超过2MB；
- 单对象是否超过6张；
- `/srv/ysm/data/attachments` 权限；
- 数据盘空间；
- Caddy请求体限制；
- 浏览器或 App 是否完成压缩。

### 15.5 SQLite 锁错误

1. 确认只有一个 App 容器：

```bash
sudo docker ps --filter name=ysm-equipment-system
```

2. 确认没有本机 Node 服务仍在访问同一数据库。
3. 检查是否有备份脚本长时间持锁。
4. 检查 WAL checkpoint。
5. 检查是否出现长事务或慢写入。
6. 重复发生时暂停上线扩容，评估 PostgreSQL。

### 15.6 数据目录突然为空

立即停止 App，不要让系统自动创建新空库：

```bash
cd /srv/ysm/deploy
sudo docker compose --env-file .env -f compose.production.yaml stop app
findmnt /srv/ysm
lsblk -f
```

最常见原因是数据盘没有挂载，程序写到了系统盘上的同名空目录。修复挂载前不要移动或覆盖文件。

---

## 16. 最终签字确认

### 技术负责人

- [ ] Docker 镜像、Compose 和 Caddy 配置通过审查。
- [ ] 公网安全加固已经真正实现，不只是配置变量。
- [ ] 数据迁移和完整性检查通过。
- [ ] 备份与恢复演练通过。
- [ ] 压测通过。
- [ ] 回滚演练通过。

签字：________________　日期：________________

### 业务负责人

- [ ] 设备和产线数据正确。
- [ ] 正式成员名单正确。
- [ ] 三角色业务流程正确。
- [ ] 测试记录没有进入生产。
- [ ] 正式二维码抽样通过。

签字：________________　日期：________________

### 公司/合规负责人

- [ ] ICP 接入状态正确。
- [ ] APP 备案处理完成或有书面确认。
- [ ] 公安联网备案已安排。
- [ ] 隐私规则和员工告知完成。
- [ ] 云账号、域名和签名材料归公司持有。

签字：________________　日期：________________

---

## 17. 官方参考资料

- [Docker Engine Ubuntu 官方安装说明](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Compose 生产部署建议](https://docs.docker.com/compose/how-tos/production/)
- [Docker Bind Mount 官方说明](https://docs.docker.com/engine/storage/bind-mounts/)
- [Docker 构建最佳实践](https://docs.docker.com/build/building/best-practices/)
- [Node.js 官方镜像](https://hub.docker.com/_/node/)
- [Node.js 版本和 LTS 状态](https://nodejs.org/en/about/previous-releases)
- [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy Reverse Proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)
- [SQLite WAL 说明](https://www.sqlite.org/wal.html)
- [工信部非经营性互联网信息服务备案管理办法](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)
- [工信部 APP 备案通知](https://www.gov.cn/zhengce/zhengceku/202308/content_6897341.htm?type=mobile-internet)
- [中华人民共和国个人信息保护法](https://www.npc.gov.cn/WZWSREL25wYy9jMi9jMzA4MzQvMjAyMTA4L3QyMDIxMDgyMF8zMTMwODguaHRtbD9yZWY9aW1i)

---

**本手册完成不代表系统已经上线。只有第 16 节三方签字确认完成，才视为具备正式开放条件。**
