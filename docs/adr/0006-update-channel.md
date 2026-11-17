# ADR 0006：更新渠道与发布职责

Status: accepted
Implementation: deferred

## 决定

2026-11-17 固化更新设计，暂缓实施。完整行为、研究来源和验收要求统一在[更新渠道设计](../update-channel.md)；本决策不表示当前应用已具备更新功能，也不授权开始开发、创建仓库或发布。

保留现有 Forge，后续接入正式发布的 electron-updater MacUpdater / Squirrel.Mac；分发采用独立公共 GitHub Releases 仓库，源码仓库的公开性由用户决定。Intel 与 Apple Silicon 产物齐备、签名公证和 metadata 验证完成后才发布。应用身份沿用 `local.pi-hub.desktop`，后续签名身份保持兼容。

渠道规划为默认稳定版和自选预览版。自动检查可关闭；下载和重启安装由用户明确触发。版本单调，切回稳定不降级；普通退出不应用仅留在 JS 缓存、尚未确认安装的下载包。

安装通过统一退出协调器处理草稿、进行中操作、原生验证及单一后台关闭。Hub 更新只替换应用，保留资料库、原始 Pi 记录和运行中的外部宿主。首版显式自定义 `--user-data-dir` 使用手动更新，避免原生重启丢失参数。

## 理由与结果

Magpie 证明了源码/发布职责分离、完整资产再发布和渠道/传输分层的价值。Pi Hub 已使用 Electron，成熟框架比另写应用交换脚本更适合当前构建与运行边界；无需为此替换整个 Forge 工具链。

首版依赖 HTTPS、文件 hash 与 macOS 应用签名验证，不能等同于 Magpie 独立 Ed25519 发布清单。增加多来源之前须补齐独立签名 manifest；此时不自建镜像或更新服务。

当前未签名应用需手动安装一次签名引导版。仓库归属、Developer ID/公证条件、隔离签名 A→B 验证和 Apple Silicon 实机验收仍待落实；开始实施还需用户新的明确指示。应用替换失败恢复不提供数据库健康回滚保证。

本决策补充[原生客户端生命周期](0002-native-pi-client.md)及[窗口与 IPC 权限](0005-desktop-windows-and-ipc.md)，不改变它们的现有实现。
