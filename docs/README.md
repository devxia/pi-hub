# 文档入口

这里是 Pi Hub 当前规则的索引。实现行为和有效决定合并在下列文件，不以阶段提案或已完成 issue 作为补充规格。产品行为变更须同步更新对应正文与 ADR；验证结果按源码/包版本记录。

| 内容 | 文档 |
| --- | --- |
| 完整产品契约与边界 | [产品规格](product-spec.md) |
| 用户任务与界面组织 | [设计简报](design-brief.md) |
| 视觉、组件与交互规范 | [DESIGN.md](../DESIGN.md) |
| 可操作设计样板 / 变量 | [样板](design/clear-order.html) / [变量](design/clear-order.tokens.css) |
| 构建、使用、排障 | [本机应用](local-app.md) |
| 已固化、暂缓实施的更新功能 | [更新渠道设计](update-channel.md) |
| Pi API 与原生边界 | [集成事实](pi-integration-facts.md) |
| SDK / RPC 技术选型依据 | [技术说明](research/pi-rpc-sdk-managed-processes.md) |
| 隔离、测试分层与执行 | [测试规则](testing.md) |
| 已执行结果及限制 | [验证记录](validation.md) |
| 统一术语 | [GLOSSARY.md](../GLOSSARY.md) |
| 开发与任务约定 | [AGENTS.md](../AGENTS.md) |

## 架构决策

1. [应用身份](adr/0001-pi-hub-fresh-identity.md)
2. [原生 Pi 图形客户端](adr/0002-native-pi-client.md)
3. [独立 Hub 数据根](adr/0003-home-data-directory.md)
4. [源身份与请求核对](adr/0004-source-and-request-identity.md)
5. [共享后台与窗口权限](adr/0005-desktop-windows-and-ipc.md)
6. [更新渠道与发布职责（暂缓实施）](adr/0006-update-channel.md)

原始测试回执用于追溯某次运行，不构成产品规则。已完成任务的有效内容归入上述正文；测试版本与失败限制统一在验证记录说明。
