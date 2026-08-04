# 优胜美设备系统：Docker 服务器安全升级说明

这份说明用于“服务器已经运行旧 Docker 版本，现在要部署 GitHub 最新代码，并按需换成开发电脑上的最新数据库”的场景。正式操作建议由 Codex 一步一步带着执行；每一步确认输出后再继续。

## 不能跳过的原则

1. 镜像只装代码，数据库和附件永远保存在宿主机目录。
2. 不直接把新数据库上传覆盖 `/srv/ysm/data/equipment.db`，必须先上传到独立的 `incoming` 目录。
3. 换数据库或让新代码首次打开数据库前，必须停止 App 并生成可校验的一致性备份。
4. SQLite 只运行一个 App 写实例。
5. 禁止执行 `docker compose down -v`、`docker system prune --volumes`，也不能删除未知数据卷或目录。

## 本次仓库提供的 Docker 文件

- `equipment-system/Dockerfile`：Node.js 24 生产镜像，非 root 运行。
- `equipment-system/compose.production.yaml`：App、备份和 Caddy HTTPS。
- `equipment-system/compose.build.yaml`：服务器直接从 GitHub 源码构建镜像时叠加使用。
- `equipment-system/.env.production.example`：环境变量模板。
- `equipment-system/scripts/inspect-database.js`：只读输出数据库数量、迁移版本、完整性和外键结果。
- `equipment-system/scripts/backup-production.js`：生成数据库与附件的一致性备份和 SHA-256 清单；默认永不自动删除旧备份。

生产容器设置了 `YSM_REQUIRE_EXISTING_DB=1`。如果数据目录没有正确挂载，或者 `equipment.db` 不存在，App 会直接启动失败，不会再生成空库。

## 两种更新方式

### 方式 A：服务器从 GitHub 源码构建（当前推荐）

在 `equipment-system` 目录执行时，所有 Compose 命令固定使用两个文件：

```bash
sudo docker compose \
  --env-file .env.production \
  -f compose.production.yaml \
  -f compose.build.yaml \
  <命令>
```

`compose.build.yaml` 会把当前 Git 提交构建成 `APP_IMAGE_BUILD` 指定的本地镜像，不需要额外的镜像仓库。

### 方式 B：私有镜像仓库

只使用 `compose.production.yaml`，并在 `.env.production` 中把 `APP_IMAGE` 固定到版本标签或镜像摘要。这种方式适合已有 CI/CD 和私有镜像仓库的服务器。

## 正式升级顺序

下面只是总览，不要在未核对服务器现状时整段复制执行。

1. 只读查看旧容器、Compose 文件、数据挂载和当前数据库数量。
2. 确认真实数据目录和备份目录，记录旧镜像 ID。
3. 拉取 GitHub 最新 `main`，但不启动新容器。
4. 构建新镜像。
5. 使用新镜像的备份工具给服务器现有数据库和附件生成一致性备份，并独立校验。
6. 如果开发电脑数据库更新了：先在开发电脑停服并生成一致性备份，再上传整个备份目录到服务器 `incoming` 目录；禁止只传一个正在使用中的 `.db` 文件。
7. 停止旧 App。需要换数据库时，通过恢复脚本恢复上传的备份；脚本会再保存一份恢复前副本。
8. 启动一个新 App 容器，等待健康状态；不同时保留两个写容器。
9. 通过 `inspect-database.js` 比对设备、产线、安装关系、账号和工单数量，并检查 `integrity_check=ok`、外键错误为 0。
10. 验证 HTTPS、登录、首页、维修工单与附件，再更新 Android App 的服务器地址。

## 第一步：只读摸底

登录服务器后先执行以下命令，把完整输出发给协助部署的人。它们不会修改容器或数据库：

```bash
pwd
sudo docker version --format 'Docker Server: {{.Server.Version}}'
sudo docker compose version
sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
sudo docker inspect $(sudo docker ps -q) \
  --format '{{.Name}} | image={{.Config.Image}} | mounts={{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}'
```

如果知道旧项目目录，再追加：

```bash
cd <旧项目目录>
pwd
sudo docker compose config --services
sudo docker compose ps
```

确认输出之前，不执行停止、删除、覆盖数据库或 `down`。

## 数据库只读核验命令

新镜像构建完成后，可以这样只读核验宿主机数据库：

```bash
sudo docker run --rm \
  --network none \
  -e YSM_DB_PATH=/data/equipment.db \
  -v /srv/ysm/data:/data:ro \
  ysm-equipment-system:server \
  node scripts/inspect-database.js
```

若服务器实际数据目录不是 `/srv/ysm/data`，必须替换成第一步查到的真实目录。

## 回滚

- 只更新代码且数据库结构兼容：恢复旧镜像标签并重建 App 容器。
- 已替换数据库：停止 App，保存故障现场，再恢复升级前的已校验备份和旧镜像。
- 任何回滚都不能删除当前数据库、附件或升级前备份；先保留副本再操作。

更完整的首次上云、HTTPS、安全组、备案、备份计划和验收要求见 [正式上云 Docker 部署执行手册](正式上云Docker部署执行手册.md)。
