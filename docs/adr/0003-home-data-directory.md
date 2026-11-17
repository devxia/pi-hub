# ADR 0003：独立 Hub 数据根

Status: accepted

## 决定

默认数据根为 `~/.pi-hub`；显式 `--user-data-dir` 优先。选定根在单实例锁和数据库打开前创建，权限 0700。Electron userData、sessionData、缓存、日志、Crashpad 与 Hub 数据库、启动配置和控制回执跟随同一根。

Pi 原生会话默认仍在 `~/.pi/agent/sessions`；Pi 用户设置保留自身目录。额外会话来源通过设置纳管，不迁入 Hub 根。应用不搜索其他 Hub 数据目录、不建立兼容回退、不自动搬迁来源。

## 理由与结果

单一明确的根便于用户查找、独立 profile、安装校验和测试清理。仅更改 HOME 无法隔离 Electron；测试必须同时核实实际 profile、HOME、agent 和 sessions 位于自有目录。

应用更新保留实际 profile；源码与应用包可以替换，用户数据不能随安装被重置。数据库损坏保留原件，迁移前创建可恢复备份。
