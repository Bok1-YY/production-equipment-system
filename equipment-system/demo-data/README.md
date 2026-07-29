# 公开演示数据

这里保存的是 2026-07-29 测试环境的一致性快照，用于让 GitHub 访问者复现当前设备管理系统成果。它不是工厂正式数据。

## 演示账号

三个账号统一使用公开演示密码：

```text
ysm-demo-2026!
```

| 工号 | 姓名 | 级别 |
|---|---|---|
| `admin` | 系统管理员 | 三级管理员 |
| `w002` | 222 | 二级技术员 |
| `w001` | 111 | 一级普工 |

快照制作时已经：

- 清除所有 Web 会话；
- 清除 Android 通知设备令牌；
- 清除登录失败/锁定记录；
- 清除幂等请求缓存；
- 为三个账号重新生成独立的 scrypt 盐和密码哈希；
- 执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。

## 文件

- `equipment-demo.db`：SQLite 演示数据库；
- `attachments-demo.tar.gz`：与数据库配套的测试附件。

SHA-256：

```text
23ababb6e84bba2c1e940d8cceab790783eb09113b67b3ccf27fc902db201285  equipment-demo.db
704e07feabab9ecaec832c74ea43f1b000425989135f92c2b6bf9bfe8c9256ea  attachments-demo.tar.gz
```

## 本地使用

以下操作会替换本地运行数据。先停止服务并备份自己的 `data/`，再从仓库根目录执行：

```bash
mkdir -p equipment-system/data
cp equipment-system/demo-data/equipment-demo.db equipment-system/data/equipment.db
tar -xzf equipment-system/demo-data/attachments-demo.tar.gz -C equipment-system/data
```

随后按主 README 启动系统，使用上面的演示账号登录。

