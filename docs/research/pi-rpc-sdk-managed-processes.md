# 独立终端宿主为何采用 SDK

## 已采用的组合

外部 Pi 1.5.2 公开 SDK 与 InteractiveMode 承载用户的原生 TUI；Hub 通过私有认证通道控制自己启动的宿主。Electron 内的 SDK 用于索引与只读投影。两者共享原生文件语义，生命周期相互独立。

## 与 RPC 的能力关系

| 项目 | RPC / RpcClient | 当前 SDK 宿主 |
| --- | --- | --- |
| 进程 | 独立 RPC 模式；RpcClient 创建并管理其子进程 | 外部终端中的 InteractiveMode，Hub 退出后继续 |
| 既有 TUI | 不提供附着任意已运行 TUI 的能力 | 只连接自己登记的宿主，不接管普通 Pi |
| 名称 | set_session_name 对空名返回错误 | AgentSession.setSessionName 保留原生清空能力 |
| Clone | 原生命令创建副本并切换；重复命令 ID 不能作为通用幂等保证 | 原生 fork 并切换，Hub 同请求账本/查询防止重复副作用 |
| 用户资源与 UI | 结构化协议事件，由客户端处理扩展 UI 等交互 | 复用资源加载、信任规则、扩展及官方交互模式 |
| Hub 断开 | 客户端子进程/EOF 生命周期需另行处理 | 控制通道断开不结束终端宿主 |

## 结果与限制

选择 SDK 是为了在原生 TUI 内执行名称清空、当前 leaf Clone、/new 和运行时切换，并保留用户资源及独立终端生命周期。协议认证、源身份、命令账本和 OS 对象核对仍由 Hub 负责；公开 SDK 不自动提供这些产品保障。

API 依据来自同版本公开 README、docs/sdk.md、docs/rpc.md、docs/rpc-commands.md、docs/session-format.md、类型导出与已运行探针。上游代码入口为 [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)。本机版本路径不作为可移植配置写死；实际安装由检测结果决定。

[集成事实](../pi-integration-facts.md)记录采用的调用和边界，[ADR 0002](../adr/0002-native-pi-client.md)定义产品架构，[验证记录](../validation.md)绑定实际探针及验收版本。API 阅读、SDK 内存回读、独立原生 CLI 重开和真实终端是不同证据层，不能互相替代。
