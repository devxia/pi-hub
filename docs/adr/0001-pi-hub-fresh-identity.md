# ADR 0001：Pi Hub 应用身份

Status: accepted

## 决定

应用显示名和可执行文件为 **Pi Hub**，npm 包为 `pi-hub`，macOS bundle ID 为 `local.pi-hub.desktop`。仓库、构建、测试、安装和当前文档使用同一身份。

应用安装为独立 .app，可离开仓库与开发服务器运行。默认数据根及隔离 profile 规则由 [ADR 0003](0003-home-data-directory.md) 定义。身份替换直接生效，不增加旧名称运行回退、双实现或兼容迁移。

## 理由与结果

统一身份让操作系统、单实例锁、自动化许可、安装和用户入口指向同一应用。包名、bundle ID 和标题不能仅修改其中一层；交付需核对 Info.plist、可执行文件、ASAR 与源码绑定。原始会话属于 Pi，应用命名不改变其存储或身份。
