# 优胜美设备管理系统 · 开发手册（DEVGUIDE）

> 生产设备的**编码建档 → 产线组合 → 报修维修**闭环系统。三级成员（普工／技术员／管理员），扫码报修，设备状态跟着工单自动走。
> 技术选型是刻意"极简"：Node 内置 HTTP + 内置 SQLite + 零框架前端，**全部运行期依赖只有 2 个包**（exceljs、qrcode）。工厂单机部署，双击图标即用。
> 本手册按当前真实代码（2026-08）维护，**开头就是启动**。读完「零」即可跑起来；要改代码再往下看。

---

## 零、快速启动 ⭐（先看这里）

### 0.1 一键启动（日常用法）

Windows 只保留一个用户入口：桌面的 `一键启动全功能设备系统.bat`。它统一启动电脑页面、手机局域网访问、扫码、巡检拍照和报修通知所需的后端，并显式设置 `YSM_DB_PATH=factory-data/equipment.db`。数据库不存在时启动器必须失败，禁止 SQLite 静默生成空库。`scripts/start-full-windows.ps1` 以独立后台进程启动 Node，轮询 `/api/health` 成功后才打开网页，并把实际 Node PID 与启动时间写入 `data/equipment-server.pid`，输出和错误日志写入 `data/server-*.log`。因此关闭启动窗口不会停服；`stop-windows.bat` 会双重校验 PID 后停止对应进程。非管理员启动不会再同步等待防火墙 UAC，保证本机页面优先可用；手机被防火墙拦截时再单独配置 TCP 8787 私有网络入站规则。

启动器在启动后端前调用 `scripts/prepare-mobile-apk-windows.ps1`。它按当前 Wi-Fi 地址和移动端源码指纹检查 `web/downloads/ysm-equipment-mobile-test.apk`；缺失、源码变化或地址变化时才下载/复用便携 JDK 21、Android SDK 和 Gradle 缓存，执行 Capacitor 同步、Gradle 构建、APK 验签并写入下载目录。构建过程会暂时改写当前地址和 Android 生成配置，但使用字节快照在成功或失败后原样恢复，不能因此把仓库弄脏。检测到 Windows 本地代理时，Java 继承代理并优先使用可直连的 Maven 镜像，Gradle 下载失败会自动重试。安装页与 APK 均可用后才继续启动服务；BAT 窗口会保留安装地址，手动关闭窗口不影响后台服务。

用户已确认 `demo-data/equipment-demo.db` 实际是 205 台设备的工厂源库。由于该文件被 Git 跟踪，不能直接承载日常写入；2026-08-04 在停服、源库与旧空库分别一致性备份并校验后，以 `VACUUM INTO` 生成 `factory-data/equipment.db` 运行副本，并恢复配套附件。日常启动只写 `factory-data/`，`demo-data/` 源文件和 `data/equipment.db` 旧空库均保留。排查“数据不见”时必须只读核对进程实际路径、三个数据库及 WAL/SHM；任何恢复或路径切换都按仓库根目录 `AGENTS.md` 执行。

Linux 桌面环境可以从项目目录运行 `一键启动设备系统.sh`。它会：

1. 检查 Node 版本（**必须 ≥ 22.5**，因为用了 `node:sqlite`）；
2. 首次运行自动 `npm install`；
3. 优先把服务交给 **systemd 用户服务** `ysm-equipment-system.service` 托管（Cinnamon 关掉启动终端会清理普通后台子进程，所以必须交给 systemd）；systemd 不可用时退化成 `nohup setsid` 独立会话；
4. 轮询 `/api/health` 最多 10 秒，起来后自动开浏览器 `http://127.0.0.1:8787`。

停止：运行 `停止设备系统.sh`。

### 0.2 手动启动（开发时常用）

```bash
cd production-equipment-system/equipment-system
npm ci               # 只有 exceljs + qrcode 两个运行期依赖
npm start            # → http://127.0.0.1:8787
npm run dev          # node --watch，改完自动重启
```

健康检查：`curl http://127.0.0.1:8787/api/health` → `{"ok":true,"data":{"status":"ok",...}}`

### 0.3 首次登录

系统第一次启动会自动建一个管理员账号：

| 工号 | 初始密码 |
|---|---|
| `admin` | `ysm-admin-2026` |

**初始密码只能用一次**：登录后 `must_change_password=1`，改密之前除 `POST /api/session/password` 和 `DELETE /api/session` 外**所有业务接口返回 403**。改完密码后立刻去「成员管理」给实际使用的人开账号。

### 0.4 端口与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | **只监听本机**。手机/别的电脑要访问必须改成 `0.0.0.0`，见 §十二 |
| `YSM_DB_PATH` | `data/equipment.db` | 手动启动默认值；Windows 一键启动固定覆盖为 `factory-data/equipment.db`，自动测试必须使用 `%TEMP%` 独立库 |
| `YSM_REQUIRE_EXISTING_DB` | 未设 | Docker 生产环境固定为 `1`；挂载库不存在时拒绝启动，防止生成空库 |
| `PUBLIC_BASE_URL` | 由请求头推导 | **决定铭牌二维码里存的地址**。正式域名定下来之前不要批量打印铭牌 |
| `YSM_SECURE_COOKIE` | 未设 | 设为 `1` 时会话 Cookie 加 `Secure`，上了 HTTPS 反代必须设 |

### 0.5 跑测试

```bash
npm test                                   # node --test，当前 156 项（155 通过，1 项缺现场真实台账时跳过）
node scripts/http-smoke.js                 # HTTP 冒烟（需服务在跑）
SMOKE_PASSWORD=你的新密码 node scripts/http-smoke.js   # admin 改过密码后
```

---

## 一、整体架构

```
        手机/电脑浏览器
              │  同源 fetch + HttpOnly 会话 Cookie
              ▼
┌───────────────────────────────────────────────────────┐
│  web/  零框架前端（无构建、无 npm 依赖、无打包）          │
│    index.html  单页 + 12 个 <section class="view">     │
│    app.js      4131 行原生 JS，按级别渲染               │
│    styles.css  设计令牌 + 760px 移动端断点              │
└───────────────────────────┬───────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────┐
│  src/server.js  Node 内置 http，900 行                  │
│    · 会话解析（Cookie → users）→ context               │
│    · 109 条 if 分支路由（无框架）                       │
│    · 静态文件服务（web/ 目录）                          │
└───────────────────────────┬───────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────┐
│  src/service.js  EquipmentService，3626 行               │
│    全部业务逻辑：台账/编码/组合/工单/成员/履历/审计      │
│    + modifications.js 1042 行，安装技改任务领域方法      │
│    ── 依赖 ──▶ domain.js（校验+状态机+常量，无 IO）      │
│              ▶ auth.js  （scrypt+会话+级别映射）        │
│              ▶ spreadsheets.js（exceljs 读写）          │
└───────────────────────────┬───────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────┐
│  src/db.js  node:sqlite（Node 22.5+ 内置）              │
│    openDatabase() = 建库 + migrate + 种子 + 种管理员    │
│    40 张表，WAL 模式；Windows 运行库 factory-data/equipment.db │
└───────────────────────────────────────────────────────┘
```

四条铁律：

1. **依赖只增不减是禁忌**。目前运行期依赖只有 `exceljs`（Excel 导入导出）和 `qrcode`（铭牌二维码）。密码哈希用 `node:crypto` 的 scrypt，数据库用 `node:sqlite`，HTTP 用 `node:http`——**加新依赖前先确认 Node 标准库真的做不到**。这套系统要在工厂的电脑上双击就能跑，装不上 npm 包的时候不能瘫。
2. **业务逻辑在 `service.js` 及其扩展模块**，`modifications.js` 通过 `installModificationMethods()` 安装技改领域方法；`server.js` 只做路由和会话解析，`domain.js` 只做校验和常量（纯函数、无 IO、可单独测）。加功能不能把业务规则塞进路由。
3. **权限在服务端判，前端隐藏只是为了界面清爽**。`applyLevelUi()` 藏掉的入口不构成安全边界；每个写接口都必须有 `assertRole`。
4. **身份只从会话 Cookie 来**。任何"从请求头/请求体读取角色"的写法都是回到 2026-07-26 之前那个可以随手伪造管理员的状态，一律拒绝。

---

## 二、目录与模块地图

```
equipment-system/
│  ── 后端 ──
├── src/server.js        HTTP 层：会话解析、109 条路由、静态服务、错误映射
├── src/service.js       ★ 全部业务：EquipmentService（含 modifications.js 安装的技改方法，合计约 150 个）
├── src/domain.js        纯逻辑：文本/编号校验、设备编码格式、工单状态机、
│                        设备状态常量（手工 4 态 vs 系统 2 态）、角色断言
├── src/auth.js          scrypt 哈希、会话签发/解析/续期、级别→角色映射、Cookie 解析
├── src/db.js            建库与迁移（40 张表）、ensureColumn 增量加列、
│                        种子工厂车间、种子管理员、nextSequence、transaction
├── src/modifications.js 技改任务领域服务：版本、留证、审核事务、通知
├── src/spreadsheets.js  exceljs：台账/组合模板生成、工作簿解析、组合导出
├── src/equipment-types.js  默认设备类型代码表（EXT/MIX/PUL…）
├── src/fault-codes.js   预置故障代码建议值（三级结构，待设备科确认）
│
│  ── 前端（零构建）──
├── web/index.html       单页外壳 + 登录闸门 + 12 个视图 section
├── web/app.js           ★ 全部前端逻辑（无框架、无模块化、按顺序执行）
├── web/scanner-utils.js 扫码解析工具（供 app.js 与测试共用）
├── web/styles.css       设计令牌（:root 变量）+ 组件样式 + 760px 移动端断点
│
│  ── 测试（node --test，156 项）──
├── test/domain.test.js            编码格式与状态机（纯函数）
├── test/service.test.js           台账/编码/组合/导入/结构删除/工单/层级字段（12 项）
├── test/auth.test.js              密码/会话/三级/成员管理/工单可见性（11 项）
├── test/equipment-status.test.js  状态两段联动/多工单/baseline（9 项）
├── test/equipment-history.test.js 设备履历聚合（4 项）
├── test/fault-codes.test.js       故障码三级结构、预置与报修校验、常用快捷按钮（15 项）
├── test/attachments.test.js       魔数校验、上限、回滚清理、可见性（10 项）
├── test/patrol.test.js            巡检、转维修、完成照片、履历集成（10 项）
├── test/work-order-review.test.js 结单权限与校验、评价、三档可见性（15 项）
├── test/work-order-withdraw.test.js 撤回边界与重新报修（8 项）
├── test/quick-report.test.js      普工极简报修、工序推导、故障分类后移（11 项）
├── test/work-order-timing.test.js 接单/到场时间戳与两段平均时长（5 项）
├── test/work-order-stages.test.js 阶段规则：接单合一、接单人校验、到场解锁（17 项）
├── test/spreadsheets.test.js      模板生成与回读
├── test/http-security.test.js     Host/Origin、登录锁定、幂等与错误边界
├── test/scheduled-tasks.test.js   点检保养计划、执行、异常与报表
├── test/database-startup.test.js  缺库拒启与数据库启动保护
├── test/mobile-scanner.test.js    扫码解析工具（scanner-utils）
├── test/operational-report.test.js 运营报表聚合与下钻
├── test/work-order-repair-redesign.test.js 维修阶段重构：核对/开工/试运行边界
├── test/modification-tasks.test.js 技改任务：全员确认、修订、审核事务与整单回滚（4 项）
├── test/modification-http.test.js  技改 HTTP 闭环：文件上传、通知、留证与审核应用（1 项）
│
│  ── 脚本 ──
├── scripts/http-smoke.js          HTTP 冒烟：401 拦截→登录→建设备→二维码→登出
├── scripts/browser-smoke.js       无头浏览器实跑 + 360/412 宽度几何检查
├── scripts/load-smoke.js          并发负载冒烟
├── scripts/backup-production.js / restore-production.js / verify-backup.js  备份、恢复与校验
├── scripts/production-preflight.js  上线前预检
├── scripts/inspect-database.js    只读检查数据库
├── scripts/generate-templates.js  生成 导入模板/*.xlsx
├── scripts/build-ledger-composition.js      从原始台账推导组合表
├── scripts/generate-equipment-naming-workbook.js  生成命名建议工作簿
├── scripts/seed-android-runtime-fixture.js  安卓真机测试隔离库种子（刻意不叫 *.test.js）
├── scripts/*.ps1                  Windows 启停与安卓测试服务器（§6.10）
│
├── factory-data/equipment.db  ★ Windows 日常运行库（含 -wal/-shm，不入 Git）
├── factory-data/attachments/  工厂运行库配套附件（不入 Git）
├── data/equipment.db           切换前旧空库，只保留不覆盖
├── data/equipment-before-*.db   改动前的手工备份（见 §六.6）
├── data/server.log      运行日志（systemd 追加写）
├── 一键启动设备系统.sh / 停止设备系统.sh
├── docs/设备编码与组合规则.md   ★ 业务规则真源
├── 导入模板/            固定提供的两个 xlsx 模板 + 填写说明
├── 资料整理/            本地原始台账与生成结果（不纳入公开仓库）
├── DEVGUIDE.md / README.md / 开发日志.md
└── package.json         依赖只有 exceljs + qrcode
```

**版本控制的仓库根在上一级**，不是本目录。公开远程为 `Bok1-YY/production-equipment-system`，默认分支是 `main`。

**代码归 git，运行数据归备份，两者不重叠**：`factory-data/`（含密码哈希、真实台账和附件）、`data/*.db` 备份、`node_modules/` 和日志被 `.gitignore` 排除。历史源库 `demo-data/equipment-demo.db` 已被 Git 跟踪，所以绝不能直接作为持续写入的运行文件；拉取代码也不得替换 `factory-data/`。改数据结构前仍然必须一致性备份（见 §六.6）。

---

## 三、数据模型（40 张表）

### 3.1 组织结构（五级）

```
factories(工厂) → workshops(车间) → production_lines(产线) → processes(工序) → positions(机位)
```

每级都有 `code`（唯一、大写、建后不可改）和 `name`（可改）。机位是设备的**安装槽位**，不是设备本身。

### 3.2 设备与安装关系（核心设计）

- `equipment`：设备本体档案。`code` 是**永久编码**，格式 `YSM-<类型码>-<关键规格>-<四位流水>`（例 `YSM-EXT-135-0001`），由 `equipment_code_sequences` 按「类型 + 关键规格」独立发号，**建档后锁定、作废不重用**。
- `equipment_installations`：**设备与机位的时间区间关系**，`installed_at` / `removed_at`。这是整个系统最值钱的设计——因为存的是区间而不是"当前位置"，可以还原**任意历史时点**的产线组合（`lineComposition(lineId, at)`）。
- 两个**数据库级唯一索引**做硬约束（不是靠代码检查）：
  - `one_active_installation_per_equipment`：一台设备同时只能在一个机位；
  - `one_active_equipment_per_position`：一个机位同时只能有一台设备。
- `composition_changes`：安装/移动/拆除/替换的**申请单**，两步走（提交 → 管理员确认）。审核通过时才写 `equipment_installations`，且**审核时重新校验现场状态**（位置可能已被别人占了）。

`composition_changes` 现为只读兼容历史。新业务使用完整的技改任务模型：

- `modification_tasks`：任务头、版本、计划时间、状态、施工总结和审核信息；
- `modification_task_members`：主负责人/协作技工及已确认的方案版本；
- `modification_task_items`：一张任务内的设备或结构变更项目、审批时状态快照、施工结果和拍照要求；
- `modification_task_revisions`：每次发布的不可变方案快照；
- `modification_task_history`：草稿、发布、确认、到场、施工、偏差、提交和审核全过程；
- `user_notifications`：分配、修订、待审核和审核结果的业务通知，供网页和 Android 轮询。

任务状态为 `DRAFT → PUBLISHED → ACCEPTED → ARRIVED → IN_PROGRESS → PENDING_REVIEW → APPROVED`。现场偏差走 `REVISION_REQUESTED → REVISING → PUBLISHED`，整改走 `RETURNED`，终止走 `CANCELLED`。发布时保存现场快照；审核通过时必须在同一个 `BEGIN IMMEDIATE` 事务内重新校验并应用所有项目，任一项目失败必须整单回滚。活动且影响生产的项目参与设备/产线派生状态：维修态优先，其次 `MODIFYING`／`ADJUSTING`，最后回到档案基准状态。

### 3.3 设备状态（六态，两套来源）

| 状态 | 谁维护 | 何时 |
|---|---|---|
| `ACTIVE` 在用 / `IDLE` 闲置 / `DISABLED` 停用 / `RETIRED` 报废 | 管理员在档案里手工选 | 随时 |
| `REPORTED` 已报修 | 系统自动 | 有未结工单，但技术员还没开工 |
| `REPAIRING` 维修中 | 系统自动 | 有工单处于维修中/等件/外协/待试运行/待审核 |

**状态是从未结工单派生出来的，不是命令式地设来设去**。核心函数 `service.syncEquipmentStatus(equipmentId, context)`：

```
查该设备全部未结工单（status ∉ {COMPLETED, CANCELLED}）
  有任一张 ∈ UNDER_REPAIR_WORK_ORDER_STATUSES → REPAIRING
  否则还有未结的                              → REPORTED
  否则                                        → baseline_status
状态没变就什么都不做；变了才 UPDATE + 写 STATUS_SYNC 审计
```

`equipment.baseline_status` 存"没有未结工单时该设备应该是什么状态"。管理员在档案里改状态**改的是它**，所以维修期间手工改成"闲置"不会被工单冲掉，工单一结束自然落到闲置。

这个设计的好处：幂等、可重算、一台设备挂多张工单也不会算错（关掉一张不会提前恢复）。任何改变"工单↔设备"关系的地方都要调它——目前是 `createWorkOrder`、`transitionWorkOrder`、`correctWorkOrderEquipment`（**新旧两台都要调**）、`updateEquipment`。

### 3.4 工单状态机

定义在 `domain.js` 的 `WORK_ORDER_TRANSITIONS`（冻结对象，值是 Set）：

```
                  接单走 assignWorkOrder，不走状态流转
                          ╭──────────╮
SUBMITTED ────────────────▶ ACCEPTED ──▶ ARRIVED ──▶ IN_PROGRESS ──▶ TRIAL_RUN ──▶ COMPLETED
   │  ↑ 普工可「撤回」      ╰──────────╯    ▲   │   ▲            │
   │    （到场前，SUBMITTED / ACCEPTED）   │   ▼   │            │（试运行不过，返工）
   │                                      │ WAITING_PARTS      │
   │                                      │   OUTSOURCED       │
   └── CANCELLED ◀────────────────────────┴───┴────────────────┘
       任何未结状态都能取消（仅管理员）

PENDING_REVIEW ──▶ COMPLETED / IN_PROGRESS   ← 不在正向路径上，只为历史数据保留
```

要点：

- **`ASSIGNED` 已删除**（2026-07-26）。它和 `ACCEPTED` 表达的是同一件事——有人负责了、还没到场——现场分不清两个名字的差别，技术员到场前要白多点一下。管理员指派和技术员抢单现在**都落到 `ACCEPTED`**，谁做的靠历史事件 `CLAIMED` / `ASSIGNED` / `REASSIGNED` 区分。`db.js` 的 `normalizeMergedWorkOrderStatus()` 把旧库里停在 `ASSIGNED` 的工单归一过来——不归一的话状态机查不到它的出边，那张单就永远推不动了。
- **`SUBMITTED` 只能走到 `CANCELLED`**。接单一律走 `assignWorkOrder`。原先 `SUBMITTED → ASSIGNED` 可以流转，界面上就冒出一个"已分派"选项，点了会把状态改成已分派而 `assignee` 是空的——**等于请人制造"分派给谁都不知道"的脏工单**。
- **推进工单要求是接单人本人**（`assertOwnWorkOrder`），管理员不受限。否则张三接的单李四能一路点到结单，而工单上的负责人和报修人的评价都算在张三头上。别人要接手得让管理员转派（历史里留 `REASSIGNED`）。
- **转派一张已经在修的单不会把它退回上一阶段**：`assignWorkOrder` 只在 `SUBMITTED` 时把状态推到 `ACCEPTED`，其余情况保持当前状态。
- `WITHDRAWABLE_STATUSES` = `['SUBMITTED', 'ACCEPTED']`，含义不变：技术员到场前。
- `WAITING_PARTS` / `OUTSOURCED` 只能回到 `IN_PROGRESS` 或 `ARRIVED`（报修信息要纠错时），不能直接跳去试运行。
- **`CANCELLED` 现在从任何未结状态可达**（仅管理员）。原先 `ARRIVED` 之后既不能撤回也不能取消，而结单要满足完整性硬校验——一张误接的垃圾单会永远挂在列表里。这是补死角，不是放权。
- **`PENDING_REVIEW` 是历史遗留**。2026-07-26 取消了"管理员验收"环节，`TRIAL_RUN` 直通 `COMPLETED`。这个状态仍保留可达 `COMPLETED`，因为改造前可能有工单正停在那里，删掉它们就永远结不了单。**不要因为"看起来没用"就删。**
- `assertWorkOrderTransition(from, to)` 拦非法跳转。

### 3.4.1 阶段模型：`POST_ARRIVAL_STATUSES` 与 `WORK_ORDER_STAGES`

**到场核对和开始维修是两道不同的业务边界。** 当前不再用一个宽泛的“到场后都能改”规则：

| 方法 | 界面区块 | 服务端阶段限制 |
|---|---|---|
| `classifyWorkOrder` | 核对报修信息 / 确认故障分类 | 技术员仅 `ARRIVED`；管理员可在 `SUBMITTED` / `ACCEPTED` 提前纠错 |
| `correctWorkOrderEquipment` | 报修信息有误，更改设备？ | 同上 |
| `updateRepairDetail` | 诊断原因与维修方法 | 仅 `IN_PROGRESS` / `WAITING_PARTS` / `OUTSOURCED` |
| `addWorkOrderPart` / `deleteWorkOrderPart` | 新增零件 / 删除错误零件记录后重填 | 同上 |
| `addWorkOrderCompletionAttachments` | 巡检工单的维修完成照片 | 同上 |
| `updateTrialResult` | 试运行结果 | 仅 `TRIAL_RUN` |

故障设备和分类统一走 `assertReportInfoStage()`。维修开始后若发现信息不对，不能直接在维修记录旁边修改，必须先沿状态机回到 `ARRIVED`；`IN_PROGRESS` / `WAITING_PARTS` / `OUTSOURCED` 都允许回退。这样界面隐藏不是唯一约束，直接调接口也跨不过去。开始维修时服务端还会再次检查 `final_equipment_id` 和 `fault_code_id`，两项未确认就拒绝进入 `IN_PROGRESS`。

维修记录、零件和维修完成照片走 `assertRepairStarted()`：到场但尚未开工时不能提前填写，进入 `TRIAL_RUN` 或历史 `PENDING_REVIEW` 后也不能越级修改，接口返回 `RETURN_TO_REPAIR_REQUIRED`。资料有误必须沿状态机回到 `IN_PROGRESS`；零件填错通过 `DELETE /api/work-orders/:id/parts/:partId` 删除并留下 `PART_REMOVED` 历史和审计，再重新填写。`assertArrived()` 仍供普通工单照片等“到场后但不要求开工”的通用操作使用。

`WORK_ORDER_STAGES` 是有序阶段表，由 `/api/meta` 下发给界面画步骤条。等零件/外协/待审核是分支，用 `includes` 并到所属阶段，不占独立步骤。**前端不许再抄一份**——抄了就会和状态机走散（§3.4 那条已经踩过一次）。
- **权限**：`CANCELLED` 要求管理员；其余（含 `COMPLETED`）技术员即可。结单权限 2026-07-26 从管理员下放给技术员，验收改由报修人的评价承担。
- `COMPLETED` 前有**五道硬校验**，权限下放给技术员之后没有第二个人把关，这五道更不能丢：
  - `trial_result` 必须命中 `TRIAL_RESULTS`。`NORMAL` 可结单；`OPERABLE_WITH_ISSUES` 可结单但强制 `trial_issue_description`；`UNABLE_TO_RUN` 不可结单，必须返回维修。结果只能由 `PUT /api/work-orders/:id/trial-result` 在 `TRIAL_RUN` 阶段写入，每次重新进入试运行都会清空旧结果，防止沿用上次结论；
  - **`final_equipment_id` 非空**——工单不挂设备就结掉，设备状态联动、维修履历和 MTBF 之类的统计全都落空。报修时允许"无法判断具体设备"，但修完了技术员一定知道自己修的是哪台，用「修正故障设备」认领即可。
  - **`fault_code_id` 非空**（2026-07-26 新增）——报修时故障码改成了选填（给普工减负，见 §3.6），代价必须在这里收回来：没有码，故障统计就等于没做。技术员用「确认故障分类」补上。
  - **`diagnosis` 非空**——界面名称为「诊断原因」。迁移 `mergeDiagnosisAndRootCause()` 会把旧 `root_cause` 一次性合入该字段并清空旧值，旧列暂时保留做备份兼容；
  - **`repair_action` 非空**——必须说明实际采取的维修措施。
  - 五道都对 `CANCELLED` 和撤回**豁免**，否则误报产生的无主工单会永远挂着。这一点每次加新校验都要重新想一遍。
- **时间戳**：`assigned_at` 在 `assignWorkOrder` 里落（`COALESCE` 保护，转派不覆盖首次接单时刻）、`arrived_at` 在 `to === 'ARRIVED'` 时落、`started_at` 在 `IN_PROGRESS`、`completed_at` 在 `COMPLETED`。四个时刻单调递增，"报修→接单→到场→完成"四段时长才算得出来。
  - 加这两列的原因：原先只有 `started_at` / `completed_at`，"路上花了多久"只能去 `work_order_history` 里翻文本，聚合不了。
  - `dashboard()` 的两个均值**只统计时间戳齐全的已完成工单**——改造前的老工单为 NULL，算进去会把均值拖低。没有数据时返回 `null` 而不是 `0`，前端显示 `—`：`0` 会被读成"响应零延迟"。
- 前端的"下一步"下拉**从 `/api/meta` 拿这份状态机**，不在浏览器里抄第二份。（抄过一次，改后端时忘了改前端，界面上给出了后端会拒绝的选项。）

### 3.5 工单评价

`work_order_reviews`：一单一评（`work_order_id UNIQUE`），三个维度各 1~5 星 + 选填评论，**可以改**。评价还可附照片，附件目标类型为 `WORK_ORDER_REVIEW`。

- 存 `technician` 姓名**快照**：技术员离职停用之后，历史评价和综合分仍然要算得出来。
- 「待评价」不是新状态，是 `LEFT JOIN` 出来的 `has_review` 布尔值。工单终态仍然只有 `COMPLETED` / `CANCELLED`——评价没交不会让工单卡住。
- 评价照片只允许评价人本人和管理员读取；技术员既看不到评价正文，也不能从附件接口旁路取图。`work_order_history` 只写“报修人已提交评价”，严禁把评分、评论或照片名放进技术员可见的时间线。
- `reopened_from_work_order_id`（在 `work_orders` 上）：重新报修时指向原单。**几天内就重新报修，本身就是"上次没修好"的信号**。

可见性规则见 §4.1，那里有一个已经踩过的坑。

### 3.6 故障代码与照片

- `fault_codes`：三级结构（`category` / `part` / `symptom`），`UNIQUE(category, part, symptom)` 防重复。服务端把可读文本回填进 `work_orders.fault_symptom`，所以工单列表、履历、审计这些下游展示一行没改；`fault_code_id` 才是统计用的结构化字段。
  - **报修时选填、结单前必填**（2026-07-26 调整）。这不是重新打开"只填自由文本"的旁路——旁路的危害是统计落空，而这里只是把**录入点从报修挪到了结单**：普工不必在三级分类里翻，到场看过的技术员分类本来就更准。收口在 §3.4 的结单硬校验。
  - 不选码时**必须给一句话说明**（`description`），否则这张工单对技术员没有任何信息量。那句话同时回填 `fault_symptom`，所以列表上显示的是普工原话；技术员补码后 `fault_symptom` 被重写成三级文本，**普工原话仍留在 `description` 里不会丢**。
  - 已知代价：故障码上的 `requires_photo` 在"不选码"这条路径上没法生效——报修时还不知道是什么故障。选了码（含快捷按钮）的仍然强制。
  - `src/fault-codes.js` 里 23 条**预置建议值**（按旧系统 YEMS 的 21 个扁平故障码整理），`is_seeded=1`，**只在表为空时种入**——管理员删掉的预置项不会在重启后复活。**待设备科确认**。
  - 兜底码 `GEN-ALL-OTHER` 选中时强制填补充说明，并用补充说明回填故障现象。它**不进快捷按钮**：点了还要再填文字，和"不选码直接写一句话"完全重复。
  - `is_common`：进不进普工报修页的「常见故障」快捷按钮。`frequentFaultCodes()` 先按该设备类型的历史频次排，**库里还没有工单时回退到 `is_common`**——否则第一天打开报修页是一排空按钮。加这个标记而不是硬编码"综合类优先"，是因为类别名管理员可以改，magic string 会静默失效。
    - `ensureColumn` 加列后有一次 `backfillCommonFaultCodes()`：只动 `is_seeded=1` 的行，且**任意一条已为 1 就不再补**——否则管理员取消掉的标记会在重启后复活（和"删掉的预置项不复活"同一个原则）。
  - 已被工单引用的只能停用不能删。
- `attachments`：多态附件表（`target_type` 为 `WORK_ORDER` / `WORK_ORDER_COMPLETION` / `PATROL` / `TASK` / `WORK_ORDER_REVIEW` / `MODIFICATION_ITEM` / `MODIFICATION_DOCUMENT`）。其中 `WORK_ORDER_COMPLETION` 是巡检转维修后的专用完成凭证，不能由普通工单照片替代；`MODIFICATION_ITEM` 是技改项目完工照片，`MODIFICATION_DOCUMENT` 是技改任务技术文件（PDF/Office/DWG 等，走原始流上传，不限于图片）。文件落 `data/attachments/YYYYMM/<32位随机名>.<ext>`，库里只存相对路径。
  - **服务端只认魔数字节**（JPEG `FF D8 FF`、PNG `89 50 4E 47`、WEBP `RIFF....WEBP`），绝不信前端声明的 mime——否则改个扩展名就能上传任意文件。
  - 单张 ≤2MB、每个对象 ≤6 张、解码后合计 ≤12MB；base64 做严格往返校验。前端先用 canvas 压到长边 1600px 再提交。
  - 落盘和写库在同一个 `transaction()` 里；任何一张失败都会 `unlinkSync` 清掉同批已写下的文件，不留孤儿。
  - 可见性跟随所属工单（`attachmentFile()` 内部调 `getWorkOrder(id, context)` 复用同一套判定）。

### 3.7 巡检

`patrol_records` 保留为技术员的快速现场巡查：扫码选设备 + 拍照 + 必填一段 `findings`。正式的逐项点检走下一节的结构化任务，二者不混用。

只给 `equipment_id` 不给 `process_id` 时，会按当前安装关系自动带出所在工序。`convertPatrolToWorkOrder()` 一键转维修：巡检发现写进工单 `description`，`work_order_id` 回写实现双向关联，工单历史里留 `FROM_PATROL` 事件，并触发设备状态联动。

巡检服务端强制至少一张附件；Android App 进一步通过自定义 `PatrolCameraPlugin` 调 `MediaStore.ACTION_IMAGE_CAPTURE`，使用 `FileProvider` 接收新拍 JPEG，不给相册选择入口。前端收到 Base64 后必须直接 `atob` 解码成 `Blob`，不能 `fetch(data:)`：页面 CSP 的 `connect-src 'self'` 会拒绝后者。随后 canvas 写入设备、巡检人和拍摄时间水印。非原生浏览器只有在 `getUserMedia` 可用时才允许巡检拍照，否则提示使用最新版 Android App，不能退回文件上传绕过现场要求。

巡检转入的工单由 `source_patrol_id` / `source_patrol_no` 标识。开工后，接单技工使用同一个原生相机桥拍摄维修完成现场，前端改写“设备、维修人、时间”水印并上传到 `WORK_ORDER_COMPLETION`。`addWorkOrderCompletionAttachments()` 同时校验角色、接单人和维修阶段；`transitionWorkOrder(...COMPLETED)` 再按独立附件类型计数，普通 `WORK_ORDER` 补拍照片不能绕过 `REPAIR_COMPLETION_PHOTO_REQUIRED`。

### 3.8 结构化点检与保养

- `task_templates` / `task_template_items`：`task_kind` 区分 `INSPECTION` 与 `MAINTENANCE`，项目支持 CHECK/NUMBER/TEXT、标准、单位、上下限与异常拍照。
- `task_plans`：对象为 PROCESS/EQUIPMENT，周期为 DAILY/WEEKLY/INTERVAL/FIXED/MANUAL。
- `scheduled_tasks` / `task_results`：`UNIQUE(plan_id,due_at)` 保证到期任务幂等生成；技术员逐项提交，数值越界由服务端强制判 FAIL。
- `abnormal_events`：异常可关闭或转工单；任务与工单双向保存关联。

### 3.9 成员与会话

- `users`：`username`（工号，小写唯一）、`display_name`、`level`(1/2/3)、`password_hash` + `password_salt`（scrypt，每次新盐）、`status`、`must_change_password`。**账号只停用不删除**，避免审计断链；系统始终保留至少一个启用的管理员。
- `sessions`：12 小时绝对到期，活动续期受 `absolute_expires_at` 封顶，且最多每 5 分钟写一次 `last_seen_at`。
- `notification_devices`：Android 后台通知使用独立 7 天 Bearer 令牌，数据库只存 SHA-256，App 用 AndroidKeyStore AES-GCM 加密落盘；不再保存或轮询会话 Cookie。
- `login_attempts`：账号与来源 IP 的持久化失败记录，支持账号锁定和来源限流。
- `idempotency_requests`：报修、巡检、任务执行和零件记录的重复提交防护。

### 3.10 审计

- `audit_logs`：除显示名 `actor` 外还保存 `actor_user_id` / `actor_username`，避免同名人员导致追溯歧义。
- `work_order_history`：工单专属时间线，含 `event_type` / 状态迁移 / 操作人 / 备注。

因为身份来自真实登录会话，`actor` 现在是可信的。

---

## 四、三级权限（关键设计）

`ROLES` 五个常量继续作为**内部权限令牌**保留，用户表只存 1/2/3，登录时映射（`auth.levelToRole`）：

| 级别 | 名称 | 内部 role | 能做什么 |
|---|---|---|---|
| 1 | 普工 | `EMPLOYEE` | 报修（扫码+一句话即可，故障分类选填）、撤回、评价、重新报修；只看自己报修的工单 |
| 2 | 技术员 | `TECHNICIAN` | 从待接单池**抢单**、维修全过程、**结单**、确认故障分类、修正故障设备、记录零件、巡检、查设备履历；**只能推进自己接的单，且到场后才能操作**；台账和产线组合**只读**；只看得到自己的综合评分 |
| 3 | 管理员 | `ADMIN` | 全部：指派与中途转派、任何未结阶段取消工单、台账、组合、变动审核、故障代码、服务评价、成员管理、审计日志。**不受「要先到场」和「必须是接单人」两条限制** |

**为什么这样映射能省掉大量改动**：`ADMIN` 本来就在每一处 `assertRole` 的允许列表里，所以三级模型落地时几十处权限校验一行没改。历史上的 `PRODUCTION_SUPERVISOR`（生产主管）和 `EQUIPMENT_ADMIN`（设备科）已合并进管理员，常量保留只是为了不动老代码。

**有三处权限不按级别判，而是按"是不是本人"判**——因为它们的主体是工单的当事人，不是某个岗位：

| 操作 | 判定 |
|---|---|
| `withdrawWorkOrder` | `reporter_user_id === context.user_id`（或管理员代撤） |
| `reviewWorkOrder` | `reporter_user_id === context.user_id`，**管理员也不能替别人评** |
| `reopenWorkOrder` | `reporter_user_id === context.user_id`（或管理员代发起） |

**普工可见性**在两处实现，不能只做一处：
- `listWorkOrders(context)`：level 1 时加 `WHERE w.reporter_user_id = ?`；
- `getWorkOrder(id, context)`：level 1 且非本人报修 → 403。

注意 `getWorkOrder` 的 `context` 默认 `null` 表示**服务内部调用不过滤**（`assignWorkOrder` 等内部会调它）；HTTP 路由层必须显式传 context。

### 4.1 评价可见性：三个口子切同一份数据 ⚠️

| | 单条评价（评论、评价人） | 技术员综合分 |
|---|---|---|
| 普工 | 只看自己提交的 | 看不到 |
| **技术员** | **完全看不到** | **只看自己的** |
| 管理员 | 全部 | 全部（含排行） |

技术员看不到单条是刻意的：能被认出来的话，普工就不敢给低分了。实现上有**两个必须同时做到的点**，只做一个会漏：

1. `getWorkOrder()` 里把 `review` 剥成 `null`（保留 `has_review` 让界面知道"评过了"）；
2. **工单历史里绝对不能写入评分和评论**。`work_order_history` 对技术员是可见的——第一版把评论写进了 `note`、分数写进了 `details_json`，接口层剥得再干净也没用，内容从时间线漏了出去。现在只记一句"报修人已提交评价"。

`myReviewSummary(context)` 只认会话里的 `context.user_id`，不接受任何入参指定别人。

---

## 五、后端：`server.js` 的 109 条路由

### 5.1 请求流程

```
http.createServer
  └─ /api/* → handleApi()
       ├─ contextFrom(request)：Cookie → resolveSession → {actor,user_id,level,role}
       ├─ 公开白名单：GET /api/health(/live/ready)、POST /api/session
       ├─ 无会话 → 401 UNAUTHORIZED
       ├─ must_change_password → 除改密/登出/GET /api/session/me/
       │   DELETE /api/notification-device 外全部 403 PASSWORD_CHANGE_REQUIRED
       └─ 顺序匹配 if (method === 'X' && (params = match(pathname, /正则/)))
  └─ 其他 → serveStatic()（路径归一化防穿越，Cache-Control: no-cache）
错误统一在 createServer 的 catch 里映射：DomainError → 它自己的 status/code；其余 → 500
```

### 5.2 端点目录

- **会话** `POST /api/session`(登录，下发 Cookie) · `DELETE /api/session`(登出) · `GET /api/session/me` · `POST /api/session/password`(改密)
- **成员**（均 L3）`GET|POST /api/users` · `PUT /api/users/:id` · `POST /api/users/:id/reset-password`
- **元信息** `GET /api/meta`(角色/级别/工单状态/变动类型) · `GET /api/dashboard`(12 项统计) · `GET /api/health`
- **组织结构** `GET /api/organization` · `GET /api/organization/tree`(带当前设备) · `POST|PUT /api/{workshops,lines,processes,positions}` · `GET /api/structure/:type/:id/delete-preview` · `DELETE /api/structure/:type/:id`
- **设备类型** `GET|POST /api/equipment-types` · `PUT|DELETE /api/equipment-types/:id`
- **设备** `GET /api/equipment?search=` · `POST /api/equipment` · `GET|PUT /api/equipment/:id` · **`GET /api/equipment/:id/history`**(设备履历，L2+)
- **导入导出** `GET /api/templates` + 两个 `/download` · `POST /api/imports/{equipment,line-composition}/{preview,commit}` · `GET /api/exports/line-composition.xlsx`
- **旧版组合变动** `GET /api/composition-changes`（只读历史）；旧 `POST` 与审核入口返回 410
- **技改任务** `GET|POST /api/modification-tasks` · `GET|PUT /api/modification-tasks/:id` · `POST :id/{publish,acknowledge,arrive,start,deviation,revise,submit-review,review,cancel}` · `PUT :id/items/:itemId/result` · `POST :id/items/:itemId/photos` · `POST :id/documents`（原始流）
- **业务通知** `GET /api/notifications` · `POST /api/notifications/:id/read` · `POST /api/notification-device`（网页会话或 Android Bearer 令牌）
- **工单** `GET|POST /api/work-orders` · `GET /api/work-orders/:id` · `POST :id/assign` · `POST :id/transition` · `PUT :id/repair-detail` · `POST :id/correct-equipment` · `POST :id/parts`
- **二维码** `GET /api/qr/:token`(解析并记扫描日志) · `GET /api/qr/:token/image.svg`(实时生成 SVG) · `GET /api/qr/process-labels`
- **评价** `POST /api/work-orders/:id/{withdraw,review,reopen}` · `GET /api/reviews/me`（L2 只看自己的综合分）· `GET /api/reviews`、`GET /api/reviews/technicians`（均 L3）
- **故障代码** `GET /api/fault-codes`（报修用，只返启用的；`?all=1` 给管理页）· `POST /api/fault-codes` · `PUT|DELETE /api/fault-codes/:id`（写操作 L3）
- **照片** `POST /api/work-orders/:id/attachments`（给已有工单补拍）· `POST /api/work-orders/:id/completion-attachments`（巡检转维修后的技工完成照）· `GET /api/attachments/:id/file`（流式返回，按所属工单判可见性）· `DELETE /api/attachments/:id`
- **巡检** `GET|POST /api/patrols`（L2+）· `GET /api/patrols/:id` · `POST /api/patrols/:id/to-work-order`
- **点检保养** `/api/task-templates/:kind` · `/api/task-plans/:kind` · `/api/tasks/:kind` · `POST /api/tasks/:id/{execute,to-work-order,close-abnormal}`
- **运营报表** `GET /api/reports/operations` · `GET /api/reports/operations.xlsx`
- **审计** `GET /api/audit-logs?limit=`

### 5.3 加新端点的范式

1. 业务逻辑写进 `service.js` 的方法，**开头第一行是 `assertRole`**（除非确实所有人可读）。
2. `server.js` 里加一条 `if`。注意**顺序**：更具体的正则要放在更宽松的前面（`/equipment/(\d+)/history` 必须在 `/equipment/(\d+)` 之前）。
3. 需要级别判断时用 `context.level` 比 `LEVELS.X`；需要角色判断时在 service 里用 `assertRole(context.role, [...])`。
4. 有校验规则的先看 `domain.js` 有没有现成的（`requireText`/`optionalText`/`positiveId`/`normalizeKeySpec`…），别重写。
5. 前端在 `app.js` 加对应的 `api()` 调用和渲染。
6. **加测试**，然后在 `开发日志.md` 顶部追加一条。

---

## 六、关键约定 & 坑（务必读）

### 6.1 `event.currentTarget` 在 `await` 之后是 `null` ⚠️ 已踩

前端最容易复发的坑。事件派发一结束 `currentTarget` 就被置空，而 async 处理函数遇到第一个 `await` 就返回了：

```js
// ✗ 错的 —— 报 Cannot read properties of null (reading 'reset')
form.addEventListener('submit', async (event) => {
  await api(...);
  event.currentTarget.reset();     // 此时 currentTarget 已是 null
});

// ✓ 对的 —— 同步存下引用
form.addEventListener('submit', async (event) => {
  const form = event.currentTarget;
  await api(...);
  form.reset();
});
```

2026-07-26 这个 bug 让登录整个走不通（密码验过了、Cookie 也发了，但抛错中断了后续流程）。当时一并修了台账和变动表单里同样的写法。**注意**：`formObject(event.currentTarget)` 作为参数**同步求值**是安全的，只有 `await` 之后再访问才出事。

### 6.1b 隐藏网格子项，网格不会自己少一列 ⚠️ 已踩，而且踩了很久

`applyLevelUi()` 给普工把侧栏 `hidden = true`。但 `.shell` 是 `grid-template-columns: 190px 1fr`——**侧栏 `display:none` 之后网格仍然是两列**，`main` 就顶到第一列去了：内容被压成 190px 宽的一条，右边 1400px 空着，标题"设备报修"折成两行。

**普工页从第一轮起就是这个样子，一直没被发现**，因为前几轮的浏览器实测只断言 DOM 取值（选中项、文案、角标），**从来没量过一个元素的宽度**。用户截图一发过来才暴露。

- 修法：`applyLevelUi()` 里同时 `shell.classList.toggle('no-sidebar', ...)`，CSS `.shell.no-sidebar { grid-template-columns: 1fr; }`。不用 `:has()`，显式类不依赖浏览器特性。
- 教训写进验证流程：**改了按级别显示/隐藏的布局，就要量几何**——`scrollWidth` vs `innerWidth`、关键容器的 `getBoundingClientRect().width`、标题的高度（折行的信号）。这类测量现在由 `scripts/browser-smoke.js` 承担：把管理员页作为对照一起量，并在 360/412 移动宽度下检查横向溢出。
- 已知且刻意保留：`body { min-width: 1080px }`，所以 760~1080px 之间会有横向滚动条。桌面优先是既有决定，响应式归到手机化路线图。

### 6.1c `hidden` 属性会被任何写了 `display` 的规则盖掉 ⚠️ 已踩

`hidden` 只是 UA 样式表里的 `display: none`，优先级最低。`.form-card label { display: grid }` 一出手，`label.hidden = true` 就完全不生效——元素照样显示。

代码里原先有四处针对单个选择器的补丁（`.identity[hidden]`、`.auth-gate[hidden]`、`.auth-card[hidden]`、`.drawer[hidden]`），说明这个坑反复踩。已换成一条全局兜底：

```css
[hidden] { display: none !important; }
```

**别再针对单个选择器打补丁。** 顺带一提，`.view` 的显示走的是 `.view.active` 类而不是 `hidden`，那条路不受影响。

### 6.2 服务只监听 `127.0.0.1`

`HOST` 默认 `127.0.0.1`，**别的设备（包括手机）连不上**。这是当前"手机扫码报修"还落不了地的根本原因，改造路径见 §十二。

### 6.3 `node:sqlite` 是实验特性

启动时会打 `ExperimentalWarning`。它要求 **Node ≥ 22.5**，API 可能随 Node 版本变化。好处是零依赖、单文件、事务简单；代价是升级 Node 时要冒烟验证。真要上多人并发/远程访问，再评估换 better-sqlite3 或 PostgreSQL。

### 6.4 单进程 + WAL

`openDatabase()` 开了 `journal_mode=WAL` 和 `busy_timeout=5000`。**在线备份不能只拷 `equipment.db`**，运行期还有 `-wal` / `-shm`；要一致性副本就先停服务再拷，或用 SQLite 在线备份机制。

`nextSequence()` 和 `transaction()` 都用 `BEGIN IMMEDIATE`，注意**不要在事务里再开事务**（`createEquipmentInsideTransaction` 这类 `*InsideTransaction` 后缀的方法就是为此存在的——它们假设调用方已经开了事务）。

### 6.5 前端没有构建步骤

`app.js` 是一整个按顺序执行的脚本，没有模块、没有打包、没有 lint 配置。改完直接刷新浏览器（服务端已设 `Cache-Control: no-cache`，但**改动大时让用户 Ctrl+Shift+R**）。函数声明会提升，所以定义顺序不敏感；但顶层的 `document.querySelector('#x').addEventListener(...)` 会在加载时立刻执行，**引用的元素必须在 index.html 里真实存在**，否则整个脚本从那行开始全挂。

自检办法：
```bash
node --check web/app.js       # 语法
# 交叉核对 app.js 引用的 id 是否都在 index.html 里（动态创建的除外）
```

### 6.6 改数据结构前先备份数据库

**git 保护的是代码，不是数据**——`data/*.db` 全部被 `.gitignore` 排除，回退代码不会回退数据。生产环境使用一致性备份脚本，不直接复制正在写入的 WAL 数据库：

```bash
YSM_DB_PATH=factory-data/equipment.db node scripts/backup-production.js /backups
node scripts/verify-backup.js /backups/ysm-backup-时间戳
```

脚本用 `VACUUM INTO` 生成数据库一致性快照，附件归档并写 SHA-256 清单；恢复脚本要求 `YSM_CONFIRM_RESTORE=YES`，且会先保存恢复前副本。`schema_migrations` 记录已应用版本；兼容老库的新增列仍通过 `ensureColumn()`。

### 6.7 无头浏览器自检法（验证前端时用，实测可行）

系统装了 `google-chrome`，Node 22 自带全局 `WebSocket`，所以**不需要 puppeteer** 就能驱动真实浏览器：

```bash
google-chrome --headless=new --disable-gpu --no-first-run \
  --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-profile about:blank &
# 然后 fetch http://127.0.0.1:9333/json/list 拿 webSocketDebuggerUrl，
# 用内置 WebSocket 连上，发 Runtime.evaluate / Page.navigate 驱动页面。
```

要点：
- 监听 `Runtime.exceptionThrown` 收集页面运行期异常——**这是发现 §6.1 那类 bug 的唯一可靠办法**；
- **异常为空不等于界面是对的。** 断言 DOM 取值也不够——§6.1b 那个"普工页内容被压成 190px"的 bug 一路躲过了四轮实测，因为没有任何一条断言去量宽度。**改了布局就要量几何**：`document.documentElement.scrollWidth` vs `window.innerWidth`（横向溢出）、关键容器的 `getBoundingClientRect().width`、标题元素的 `height`（折行信号）、`getComputedStyle(el).gridTemplateColumns`。拿另一个角色的页面当对照一起量，差异一眼就看出来。
- 拿不准的时候直接 `Page.captureScreenshot` 存成 png 看一眼，比堆断言快。
- 表单用 `form.requestSubmit()` 触发（`submit()` 不走 submit 事件）；
- **必须先 `Network.enable` 再 `Network.setCacheDisabled`**，否则后者是空操作，会拿到缓存里的旧 `app.js`（踩过，白排查一轮）；
- 测试**用临时库**（`YSM_DB_PATH=/tmp/xxx.db PORT=8799`），别动生产库和 admin 密码。**每次跑之前删掉临时库**：脚本第一步会把 admin 初始密码改掉，复用旧库第二次就登不进去（踩过）；
- 用 `Emulation.setDeviceMetricsOverride` 换宽度测窄屏，跑完 `clearDeviceMetricsOverride`；
- `pkill -f "src/server.js"` 会连自己所在的 shell 一起匹配掉，**用 PID 文件收尾**；
- 通过接口直接造的数据不会反映到已加载的页面上，要 `Page.navigate` 重进一次。

### 6.8 铭牌二维码地址 ⚠️ 上线前的硬阻塞

二维码内容是 `${PUBLIC_BASE_URL || 按请求头推导}/?scan=<token>`，拼接逻辑在 `server.js` 的 `qrBaseUrl(request)`（QR 图片路由和 `/api/meta` 共用一处，别写两遍）。

**没配 `PUBLIC_BASE_URL` 时，从工厂那台电脑打印出来的码里烧的是 `http://127.0.0.1:8787`——手机扫了打不开。** 205 张铭牌白印。所以：

- `/api/meta` 下发 `qr_base_url` 和 `qr_base_url_configured`；
- 铭牌界面（单张预览和批量打印）都调 `qrAddressNotice()`，**把实际会烧进码里的那串地址原样显示**，没配就挂红色 `.notice-danger`；
- **不拦着打印**（要能先试排版），但警告必须躲不过去。

token 本身是稳定映射（存在 `qr_mappings`），换地址只需改环境变量重新打印，但已贴的旧牌会失效。

**二维码只贴单台机器。** 库里还有 57 个 `PROCESS` 类型的映射（早期给工序发的），但工序在这个厂的语义是"产线下的顺序"，不是扫码对象——那些码没有打印入口，实际是死数据。扫到了会按所属产线处理（把设备选择器缩到那条线），不会报错。

### 6.8.1 铭牌为什么不印车间/产线/工位

`labelHtml()` 刻意只印设备码、现场别名、标准名称、品牌型号和二维码。

**设备会调线、移机、替换。** 位置一旦印死在铭牌上，设备一动铭牌就成了错的，而且会让人按过期信息找错机器。位置扫码就看得到，而且取的是 `equipment_installations` 里的当前值——这套系统最值钱的设计就是那张表用时间区间记住了设备搬过哪些位置，把位置印在纸上等于主动放弃它。

### 6.9 技术债记账（刻意不做的）

- ~~**完成工单不强制填故障设备归属**~~ ✅ 2026-07-26 已做：`to === 'COMPLETED' && !final_equipment_id` 时拒绝。取消和撤回**不受此限**——误报的无主工单还得能结束掉，否则会永远挂着。
- **`guarded()` 的重抛没被普遍接住**：它 flash 完还会把错误抛出去（少数调用方靠这个恢复按钮状态，比如两处导入按钮的 `catch { commit.disabled = false; }`），但约 36 处表单 submit 处理器直接 `await guarded(...)` 不接。后果是**每一次预期内的校验失败都会多出一条未处理的 Promise 拒绝**——用户看不见（flash 已经提示过了），但会污染控制台，并且让 §6.7 那套"监听 `Runtime.exceptionThrown` 找真 bug"的验证手段失去信噪比。
  - 已单独收口的三处：`mutateWorkOrder`、`#first-password-form`（原密码打错是常见失误）、`#repair-form`（普工唯一的高频入口，且快捷按钮里有要求拍照的码）。
  - 正确的做法是从源头改：让 `guarded()` 默认不抛，给那三个真正需要的调用方一个显式的 `{ rethrow: true }`。没在本轮做是因为要动 36 个调用点，回归面比收益大。**下次碰前端时顺手做掉。**
- **台账导入不幂等**：`流程优化评估报告.md` 的 P0-1。组合导入是整批事务 + 文件哈希去重，台账导入也已改成整批事务，但没有按 legacy_code/品牌+出厂号做跨文件去重。
- **停机时长双口径**：`started_at`/`completed_at` 自动记录，`downtime_minutes` 由技术员手填，两者可能打架。
- **变动申请不能撤回**：`CHANGE_STATUSES` 里定义了 `CANCELLED` 但全代码从不使用。
- **审核用 `prompt()`**：`reviewChange()` 还在用浏览器原生弹窗填驳回原因，看不到申请详情，移动端体验差。
- **`service.js` 已 3626 行**：技改任务已按此思路拆到 `modifications.js`（`installModificationMethods()` 安装到同一个类上）；成员管理、计划任务、运营报表和履历聚合也已形成相对独立的功能组，将来继续按这些边界拆。

### 6.10 Android 改动必须跑 APK，不以“能打包”为验收

Web 冒烟不能覆盖 Android 权限、Intent、FileProvider、系统相机和 WebView CSP。涉及扫码、拍照、通知、服务器切换或 Capacitor 桥的改动必须完成以下最小闭环：

1. `cap sync android` 后运行 Android 单元测试、`lintDebug`、`assembleDebug` 和 `assembleDebugAndroidTest`；
2. 在真实 Android 设备安装 APK，确认冷启动和登录；模拟器只能作为补充，不能代替真机验收；
3. 实际点击权限按钮和系统组件，不只调用插件方法；
4. 拍照后必须回到应用，看到带水印缩略图且业务提交按钮解锁；
5. 用 `adb shell dumpsys activity activities` 核对前台是相机 `CaptureActivity`，不是 Photo Picker；
6. 直接运行 instrumentation，看到 `OK` 后才算通过。

技改任务通知由 `RepairNotificationService` 一并轮询。前台服务同时读取维修待接单和 `/api/notifications`，按业务通知 ID 去重；点击技改通知向 `MainActivity` 传入 `modification_task_id` / `notification_id`，Capacitor 插件消费后调用 `openModification()` 并标记已读。通知设备注册的请求体必须显式 `JSON.stringify()`，所有无字段的 JSON POST 也要发送 `{}`，否则 Node JSON 解析器会返回 `INVALID_JSON`。

Windows 没有 WSL 也不能成为不测的理由：可以使用便携 JDK 21、Android command-line tools、WHPX 模拟器。`scripts/start-android-runtime-test-server.ps1` 只监听 `127.0.0.1` 并把数据库限制在 `%TEMP%\ysm-android-runtime-test`；模拟器专用构建临时指向 `http://10.0.2.2:8787`。**测试完必须把 `mobile/capacitor.config.json` 恢复为实际局域网地址，再同步并重建交付 APK。** `scripts/seed-android-runtime-fixture.js` 只用于该隔离库，文件名刻意不以 `test.js` 结尾，避免被 `node --test` 自动发现。

---

## 七、开发工作流

**加一个功能**（典型全链路）：

1. 有数据结构变化 → 停止服务，对 `factory-data/equipment.db` 执行 `backup-production.js` 并用 `verify-backup.js` 校验，再在 `db.js` 的 `migrate()` 里用 `ensureColumn` 加列。
2. 纯校验/常量/状态机 → `domain.js`（保持无 IO、可单测）。
3. 业务逻辑 → `service.js` 加方法，第一行 `assertRole`。
4. 暴露接口 → `server.js` 加路由（注意正则顺序）。
5. 前端 → `app.js` 加渲染 + `index.html` 加结构 + `styles.css` 加样式（复用已有令牌和 `.status` / `.detail-block` / `.history-item` 等类）。
6. **写测试**：`test/*.test.js`，用 `openDatabase(':memory:')` 起干净环境。
7. **验证三件套**：
   ```bash
   node --check web/app.js
   npm test
   node scripts/http-smoke.js        # 服务在跑的话
   ```
   涉及界面的再做一次 §6.7 的无头浏览器实跑，确认 `Runtime.exceptionThrown` 为空。
8. **在 `开发日志.md` 顶部追加一条**（改了啥、为什么、怎么验证的）。
9. 业务规则有变 → 同步 `README.md` 和 `docs/设备编码与组合规则.md`。

**测试写法**：全部用 `node:test` + `node:assert/strict`，`openDatabase(':memory:')` 建库，`contextFor(user)` 复刻服务端从会话构造上下文的方式，保证测试和真实 HTTP 路径走同一套映射。

---

## 八、业务规则速查

完整规则见 [`docs/设备编码与组合规则.md`](docs/设备编码与组合规则.md)，这里只列最常被问到的：

- **设备码格式**：`YSM-<2~4位大写类型码>-<可选关键规格>-<四位流水>`，例 `YSM-EXT-135-0001`、`YSM-MIX-H800-C2500-0001`、`YSM-PUL-0001`。同一「类型码 + 关键规格」独立四位流水。旧格式 `YSM-EQ-000001` 仍被 `isValidEquipmentCode` 接受。
- **建档后锁定**：设备码、类型代码、关键规格不可改；名称、别名、品牌、负责人等可改。
- **组合导入的设备匹配顺序**：永久编码 → 原资产编号 → 品牌+出厂编号。**绝不按名称模糊匹配**；都匹配不上时必须提供名称+类别+类型代码，由系统发新码。
- **两个导入都是"预览 → 确认"两步 + 整批事务**：任意一行错，整批不写入。组合导入还有文件哈希去重（同一个 xlsx 不能成功导入两次）。
- **结构删除**：车间/产线/工序/机位只允许递归删除完全没有业务历史的空分支；存在设备安装、组合变动、维修工单或巡检记录时一律阻断。绝不通过删结构级联清除工单、零件、评价或附件；正常退役走 `status=DISABLED`。工厂节点不提供删除。

---

## 九、前端：`web/`

### 9.1 状态与渲染

`app.js` 顶部一个 `state` 对象（`me` / `members` / `faultCodes` / `quickFaults` / `meta` / `patrols` / `photos` / `organization` / `organizationTree` / `equipment` / `equipmentTypes` / `workOrders` / `selectedWorkOrder` / `modificationTasks` / `selectedModification` / `modificationDraftItems` / `editingModificationId` / `notifications` / `taskModules` / `expandedNodes` 等）。没有响应式框架，**改数据后手工调对应的 `loadXxx()` 重渲染**。

启动流程：`startSession()` → `GET /api/session/me` → 401 就显示登录闸门；`must_change_password` 就显示改密表单；否则 `applyLevelUi()` + `refreshAll()` + `handleScanLink()`。

### 9.2 按级别渲染

- `applyLevelUi()` 遍历所有 `[data-min-level]` 元素，级别不够就 `hidden = true`。导航项、"新建设备"表单、导入按钮、"新增车间"都挂了这个属性。
- 动态生成的按钮用 `canManage()` 门控（树节点的增删改、台账行的编辑）。
- `treeNode()` 有两个动作槽：`actions`（管理员限定）和 `alwaysActions`（不分级别，目前只有设备的"档案"按钮）。
- `refreshAll()` 按级别只加载用得上的数据——普工不拉台账树、变动申请和成员清单。

### 9.3 常用工具

`escapeHtml()`（**所有拼进 innerHTML 的用户数据都必须过它**）、`formatTime()`、`formObject(form)`、`guarded(task, msg)`（统一错误提示 + 401 自动退回登录）、`api(path, options)`、`flash(msg, type)`、`statusBadge(status)`、`optionList()`、`replaceOptions()`。

抽屉（drawer）是重复出现的模式：`document.createElement('div')` + `className='drawer'` + `innerHTML` + 绑 backdrop/close，见 `openEquipmentProfile`、`openMemberDrawer`、`openStructureDrawer`、`showLabel`。

### 9.4 报修表单（普工唯一的高频界面）

字段顺序是刻意排的，**从上到下就是普工最省事的操作顺序**：

1. **哪台设备** —— 扫二维码自动带出（`applyScanToRepair`）
2. **所属工序** —— `syncRepairProcessField()` 默认把它 `hidden` 掉：设备登记了安装位置，服务端就能推出工序。**只有设备推不出工序（没装在机位上）或选了"无法判断具体设备"时才显示并变必填**。让普工每次都选一遍工序是这个表单原先最没必要的一步。
3. **哪里不对劲** —— 必填/选填是动态的，见下
4. **现场照片** —— 推荐，不强制。系统现在还跑在工厂电脑上，没摄像头，强制会直接把桌面端报修堵死
5. **常见故障快捷按钮** —— 点一下等于选完三级
6. 两个 `<details class="fold">`：完整故障分类、更多（位置/紧急程度/停机）

两个容易写错的地方：

- **说明栏的必填条件必须和服务端一致**：没选故障码时必填（那句话是技术员到场前唯一的信息来源），选了码就变选填——**省下这一步打字才是给普工减负的意义**。兜底码「其他」是例外，它本身不说明任何问题。逻辑在 `updateFaultTip()`，服务端对应 `resolveReportedFault()` + `faultSymptomText()`。第一版把它写成无条件必填，结果点了快捷按钮还要打字，等于白做——是上一轮的浏览器实测把这个问题挡下来的。
- **快捷按钮要把三级级联一起设好**（`selectFaultCode()`）。只记住一个 id 不行：`fault_code_id` 挂在级联最后那个 `<select>` 的 `name` 上，不设级联的话 `formObject()` 取不到值，而且展开"完整故障分类"会看到和按钮对不上的状态。
- 要求拍照的故障码，按钮上先标「· 需拍照」——别让普工点完才被拦。

工单详情里那份三级级联是**另一套控件**（id 前缀 `detail-`），联动要单独接一次（`bindDetailFaultCascade()`）：报修页那套 id 不能重名。

### 9.4.1 设备选择器（分级 + 搜索）

205 台设备平铺在一个 `<select>` 里根本找不到——按编码排序，跟现场位置毫无关系。四处都用同一个选择器：报修、巡检、设备变动的"当前设备"和"替换后设备"。

**结构：一个真实字段 + 两个筛选器。**

```html
<div class="equip-picker" data-picker="repair">
  <input data-picker-search>                    <!-- 筛选器 -->
  <select data-picker-workshop><select data-picker-line>   <!-- 筛选器 -->
  <select name="equipment_id" data-picker-equipment>       <!-- ★ 唯一的真实表单字段 -->
</div>
```

三条实现约束：

- **刻意保留原生 `<select>`**，不做自研下拉。手机上原生选择器是系统级大列表，比任何自研控件好按；而且不引入依赖（§一 铁律 1）。
- **搜索和分级互斥**：`refreshEquipmentPicker()` 里有关键字就忽略车间/产线，事件里也会把那两个下拉清空。否则"搜索 ∩ 产线"经常交出空集，人会以为界面坏了。
- **选项顺序直接吃 `listEquipment()` 的 `ORDER BY`**（车间 → 产线 → `pos.sequence_no`），前端只顺序遍历切 `<optgroup>`，不再排一遍。选项文本是 `工位序号 · 现场别名 · 设备码`——工人认的是"这条线第几位的那台"，`alias`（台账里 205 台全填了，例如 `1#SPC混料机`）才是车间里真正的叫法，`standard_name` 太笼统（一堆"高速混料机"）。

**踩过的坑：`refreshAll()` 里 `loadOrganization()` 和 `loadEquipment()` 是并发的。** 车间/产线两级来自前者，设备来自后者——只在 `loadEquipment()` 里刷选择器的话，谁先回来不定，车间下拉会时不时只剩一个空选项。**两个 load 函数末尾都要刷一次。** 合成数据下这个竞态很难复现（组织树数据小、总是先到），是拿真实的 205 台设备跑才暴露出来的；当时的浏览器实测靠"连续重进页面 4 次"把它逼出来。

### 9.5 工单详情的阶段模型（技术员的主界面）

`renderWorkOrderDetail` 按阶段出内容，**不是把所有表单一次铺开**。2026-07-26 之前就是一次铺开的：工单刚提交、没人接单时，"修正故障设备/确认故障分类/诊断与维修记录/使用零件"四块全在那儿，而结单藏在一个通用的「下一步」`<select>` 里，从接单到结单要在那个下拉里点 5 次，没有任何提示说还剩几步。用户的原话是"我没在技术员那里面看到能手动结单的东西"。

现在的结构，自上而下：

1. **步骤条**（`stageBar()`）——走过的绿、当前的高亮、没到的灰。回答"我在第几步、还剩几步"。
2. **当前这一步**（`.stage-block`）——每个阶段**只有一个动词明确的主按钮**：我接这单 / 我到现场了 / 开始维修 / 修完了，转试运行 / 结单。分支（等零件、外协、返工）做成次要按钮。表在 `STAGE_ACTIONS` 和 `STAGE_BRANCHES`。
3. **问题信息** —— 一直可见。
4. **已到场：核对报修信息** —— 故障分类与“报修信息有误，更改设备？”合并在同一区块；两项确认后才能开始维修。
5. **开始维修后解锁**：诊断原因、维修方法、使用零件和巡检工单的完成照片；报修信息区块不再重复出现。错误零件可删除后重填；设备或分类要纠错时返回 `ARRIVED`，再修改并重新开工。
6. **待试运行**：维修记录、使用零件和完成照片编辑区全部隐藏，只保留结构化试运行单选项。正常运行可结单；可运行但仍存在问题必须填写说明；无法运行或维修资料有误都显式返回 `IN_PROGRESS`。
7. **结单前检查**（`TRIAL_RUN` 阶段）—— 五道硬校验（故障设备、故障分类、诊断原因、维修措施、试运行）及按需完成照片各一行。缺项行是可点击按钮：前端根据 `data-return-status` 沿状态机返回，再用 `scrollIntoView` 定位和聚焦目标表单；未补齐时结单按钮显示"还差 N 项才能结单"。

三条实现约束：

- **检查清单的判定条件必须和服务端 `transitionWorkOrder` 的五项结单校验一致**。前端只是把它们提前显示出来，**把关仍然在服务端**；`test/work-order-review.test.js` 和 `scripts/browser-smoke.js` 分别覆盖接口规则与真实页面运行。
- **阶段隐藏必须有服务端同等限制**。不能只把维修表单从 `TRIAL_RUN` 隐藏；`assertRepairStarted()` 同时拒绝直接接口修改。返回维修会清空旧试运行结果，避免返工后沿用旧结论。
- **不是接单人就什么按钮都不给**，只显示「这张工单由某某负责，需要接手请让管理员转派」。判定 `isMineToWork` 和服务端 `assertOwnWorkOrder` 是同一套。
- 阶段按钮用 `data-to-status` 属性携带目标状态，`bindWorkOrderForms` 里统一绑一次。**不要退回通用下拉**——按钮文案就是动作本身，技术员不用猜。

### 9.6 设备档案抽屉（`openEquipmentProfile`）

四个标签页由 `profileBasicTab` / `profileMovementTab` / `profileRepairTab` / `profileAuditTab` 分别渲染，数据一次性来自 `GET /api/equipment/:id/history`。基本信息页管理员可编辑、技术员只读；状态下拉只列手工四态，设备正在维修时标题改成"结单后的状态"并给出说明。

### 9.7 运营报表下钻

`operationalReport()` 同时返回三组排行：`lines`（产线故障排行）、`fault_categories`（故障类别排行）、`equipment`（设备故障排行，带故障发生时的 `line_name`）。不要用设备“当前产线”回填历史排行，设备调线后会篡改过去的统计口径。

三个表格行都带 `data-action="report-drilldown"`，鼠标、Enter 和空格都能打开抽屉。抽屉调用 `GET /api/reports/operations/work-orders`，按 `kind=line|fault_category|equipment` 及日期范围返回关联工单，再复用 `openWorkOrder()` 打开完整详情。下钻端点和报表本体使用相同管理员权限，不能因为它只是“详情”就放宽数据范围。Excel 导出必须与页面保持同样的三组排行和列定义。

---

## 十、部署与运维

- **Windows 工厂环境**：日常启动写 `factory-data/equipment.db`，服务由 `start-full-windows.ps1` 创建独立后台进程；改完代码需要用 `stop-windows.bat` 精确停止后再启动。前端文件虽然没有构建步骤，也必须确认实际服务已加载新代码。
- **阿里云当前部署**：2026-08-04 已把 `/home/ecs-user/ysm-app` 的旧 systemd 服务切换为 Docker。发布源码位于 `/home/ecs-user/ysm-releases/aa33b63/equipment-system`，服务器专用 Compose 配置位于 `/home/ecs-user/ysm-deployment`，正式数据与备份分别位于 `/home/ecs-user/ysm-data`、`/home/ecs-user/ysm-server-backups`。旧 `ysm-equipment-cloud-test.service` 保留作回滚依据，但必须保持 `disabled/inactive`，禁止与 Docker 同时写 SQLite。
- **容器约束**：当前只运行 `ysm-equipment-system-app-1`，镜像为 `ysm-equipment-system:aa33b63`，重启策略为 `unless-stopped`；`/home/ecs-user/ysm-data -> /data` 可写，APK 下载目录只读挂载到 `/app/web/downloads`。升级必须先在独立数据库副本启动并执行 `inspect-database.js`，再停旧写进程、生成最终一致性备份、确认无打开句柄后切换。
- **备份**：Windows 和 Docker 环境都使用 `scripts/backup-production.js`，得到一致数据库、`attachments.tar.gz` 与 SHA-256 清单，再用 `scripts/verify-backup.js` 或只读检查脚本验证。不要在线直接复制主库；恢复前必须停 App。备份程序没有自动清理入口，历史备份不得因部署或空间整理被顺手删除。
- **镜像网络**：本次 ECS 访问 Docker Hub 超时，实际构建对 Dockerfile 输入临时改用国内可访问的镜像前缀，并记录基础镜像摘要；没有修改仓库源码。后续重复构建优先配置阿里云账号自己的 ACR 加速或制品订阅，并继续使用明确版本标签和摘要，不依赖 `latest`。
- **公网边界**：当前 `http://8.136.107.181:8788` 只用于阶段验收。正式推广必须启用 Caddy/HTTPS，把 `PUBLIC_BASE_URL` 与 `YSM_TRUSTED_ORIGIN` 设为同一正式域名，启用 `YSM_SECURE_COOKIE=1`，重新生成正式签名 Android 包后再印二维码。

---

## 十一、版本控制

- **仓库根是上一级**，公开远程为 `Bok1-YY/production-equipment-system`，默认分支是 `main`。
- 身份配置是**仓库内**的（`git config user.name/user.email`），没动全局配置。要设成全局：`git config --global user.email "你的邮箱"`。
- **提交前必看**：`git status --short` 确认没有 `.db` / `node_modules` / `.log` 混进去。两层 `.gitignore`（仓库根 + `equipment-system/`）互为保险。
- 提交信息沿用 `feat/fix/docs/chore(scope): 说明` 风格，并保持「改完在 `开发日志.md` 顶部追加一条」的习惯。
- 代码里 `ysm-admin-2026` 是**公开的种子密码**（首次登录强制改密，README 里明确写着），部署时必须完成首次改密。`资料整理/` 的真实台账不进入公开仓库；`导入模板/` 只保留通用示例数据。

## 十二、正式手机端约束（重要）

Android 正式包通过 `mobile/scripts/build-production.sh https://正式域名` 构建：仅接受 HTTPS，release 清单禁用明文流量与系统备份，签名、包名和版本全部由环境变量注入。后台维修通知使用独立 7 天设备令牌并由 AndroidKeyStore 加密保存，不保存网页会话 Cookie。

`PUBLIC_BASE_URL` 与 `YSM_TRUSTED_ORIGIN` 必须使用同一正式 HTTPS 域名；它同时决定设备和工序二维码的永久地址。域名未确定前不得批量打印二维码。正式构建还必须提供 release keystore，并在发布前执行 Android release 单元测试、lint、APK 和 AAB 构建。

局域网测试包与正式包是两条配置线：测试包可使用可信私网 HTTP，并通过 App 内服务器设置切换地址；正式包只允许 HTTPS。Windows 交付测试包时要提高 `ysmVersionCode`，并复用电脑已有的调试 keystore，否则手机无法覆盖安装旧测试版。交付前用 `apksigner verify --verbose --print-certs`、`aapt dump badging` 和 SHA-256 同时核对签名、包名、版本及文件一致性。

---

## 十三、一句话回顾

**改业务** → `src/service.js`（第一行 `assertRole`）；**改校验/状态机** → `src/domain.js`；**改接口** → `src/server.js`（注意正则顺序）；**改界面** → `web/app.js` + `index.html` + `styles.css`；**改数据结构** → 先备份，再用 `db.js` 的 `ensureColumn`。改完跑 `npm test`，界面改动用无头 Chrome 实跑一遍确认没有运行期异常，最后在 `开发日志.md` 顶部记一条并提交。启动就是双击桌面图标。
