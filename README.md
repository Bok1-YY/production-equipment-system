# Production Equipment System

一套面向生产现场的设备管理系统，覆盖设备编码建档、产线组合、扫码报修、维修工单、巡检、服务评价和审计追踪，并提供 Web 界面与 Android 局域网测试端。

项目采用轻量技术栈：Node.js 内置 HTTP 与 SQLite、原生 HTML/CSS/JavaScript，以及 Capacitor Android 壳。适合单机试点、业务验证和二次开发。

## 主要功能

- 三级成员权限：普工、技术员、管理员；
- 永久设备编码、台账、Excel 批量导入和二维码铭牌；
- 车间—产线—工序—机位—设备组合树及历史时点还原；
- 报修、接单、到场、维修、试运行、结单和评价闭环；
- 设备巡检、附件上传、设备履历和全操作审计；
- Android 相机扫码及厂区 Wi-Fi 内的待接单通知。

## 快速开始

要求 Node.js 22.5 或更高版本。

```bash
git clone https://github.com/Bok1-YY/production-equipment-system.git
cd production-equipment-system/equipment-system
npm ci
npm start
```

浏览器访问 <http://127.0.0.1:8787>。

首次启动会创建测试管理员：

| 工号 | 初始密码 |
|---|---|
| `admin` | `ysm-admin-2026` |

首次登录必须修改密码。公开网络或生产部署前，还应配置 HTTPS、正式身份认证、安全备份及 `YSM_SECURE_COOKIE=1`；不要直接将默认配置暴露到公网。

常用环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `8787` | 服务端口 |
| `YSM_DB_PATH` | `data/equipment.db` | SQLite 数据库路径 |
| `PUBLIC_BASE_URL` | 从请求推导 | 设备铭牌二维码的公开访问地址 |
| `YSM_SECURE_COOKIE` | 未启用 | 设为 `1` 后仅通过 HTTPS 发送会话 Cookie |

## 测试

```bash
cd equipment-system
npm test
```

测试覆盖身份与权限、设备编码和状态、产线组合、附件、巡检、报修状态机、评价、时长统计、二维码扫描及 Excel 模板。

## Android 局域网测试端

Android 端是连接电脑服务的 Capacitor 测试壳，不包含离线同步或公网推送。电脑和手机必须连接同一个可信 Wi-Fi。
App 顶部“服务器”可以手动修改后端根地址，后端不可达时也能从离线页修改。测试包允许
`http://私网IP:端口`，正式包只接受 `https://域名`；这项配置不是公共 DNS 解析器地址。

在仓库根目录运行：

```bash
./一键打包安卓测试版.sh
```

脚本会优先选择真实的 `10.*`、`172.16-31.*` 或 `192.168.*` Wi‑Fi 地址，排除 Mihomo/Clash 的 `198.18.*` 虚拟网卡。每次都会先运行后端全量测试与真实浏览器冒烟，再运行 Android 单元测试和 lint、构建并校验 APK、重启端口 `8788` 的当前后端，并核对网页、安装页、APK 下载以及 APK 内嵌地址。连接了 USB 调试手机时，还会自动运行仪器测试、覆盖安装并启动 App。结果写入 `安装包/最近一次联调报告.txt`。

首次运行需要接受 Android SDK 许可并下载相关工具。生成的 APK、二维码、数据库、报告和日志均不会提交到 Git。

完整测试说明见 [手机测试说明.md](手机测试说明.md)。

## 项目结构

```text
.
├── equipment-system/
│   ├── src/                # Node.js 服务与业务逻辑
│   ├── web/                # 原生 Web 前端
│   ├── mobile/             # Capacitor Android 测试端
│   ├── test/               # Node.js 测试
│   ├── scripts/            # 模板与数据处理脚本
│   ├── docs/               # 业务规则文档
│   └── 导入模板/           # 通用 Excel 导入模板
├── 一键打包安卓测试版.sh
├── 一键启动手机测试服务.sh
└── 停止手机测试服务.sh
```

更详细的使用和业务规则见 [系统说明](equipment-system/README.md)，架构、数据模型和开发约定见 [开发手册](equipment-system/DEVGUIDE.md)。

## 数据与安全

运行数据库、现场附件、日志、APK、原始设备台账和本机配置均被 `.gitignore` 排除。生产数据应使用独立的文件系统备份，不应提交到版本控制。

该 Android 版本使用局域网 HTTP，仅适合可信网络内测试。生产环境应使用 HTTPS 反向代理、稳定域名、正式签名包和完善的访问控制。

## License

[MIT](LICENSE) © 2026 Bok1-YY
