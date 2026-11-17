# Pi 集成事实

当前实现与新验收统一使用 Pi 1.5.2（官方最新版本核实日期 2026-11-16），Node 24+。本文件记录已采用 API 和边界；具体运行结果见 [验证记录](validation.md)，完整产品语义见 [产品规格](product-spec.md)。

## 公开 API 与宿主

包内 SDK 用于原生结构解析和只读投影；外部宿主由实际检测过的 Pi 安装加载公开 SDK、AgentSession、SessionManager 与 InteractiveMode。宿主运行在外部终端的独立进程，而非随 Electron 一起关闭的内嵌聊天进程。

| 能力 | 实现依据 |
| --- | --- |
| 原记录打开 | 检查源身份及完整 v3 header，再通过公开 SessionManager/SDK 恢复 |
| 名称/清空 | 连接宿主调用 AgentSession.setSessionName；未连接时公开 SessionManager 原生名称事件 |
| 原生 Clone | runtimeHost.fork(leaf, {position:'at'})，创建新 ID 并切换当前运行时 |
| 分支/新会话切换 | 重新绑定 AgentSession、SessionManager、事件与原生 ID/文件 |
| 只读预览 | 内存树、活动 leaf、buildSessionProjection 等公开纯函数；不写回源记录 |
| 正常退出 | 验证精确进程后 SIGTERM，由 InteractiveMode 完成清理，再关闭精确终端对象 |

用户资源通过 Pi 公开加载流程提供：模型/认证、扩展、包、项目指令和信任。外部宿主经用户交互登录 shell（-ilc）运行，保留其导出环境与 PATH，并使用已检测的 Node。启动描述只保存非秘密上下文，真实凭据不落 Hub 文件。用户扩展可以取消或影响原生操作，结果必须如实处理。

## 原生记录与只读解析

文件头 ID/cwd、消息、名称、标签、压缩、context-edit 和树引用保持 Pi 原意。名称不等于身份；时间元数据不等于新对话。未连接的预览以原生恢复叶语义为准，已连接宿主提供当前活动 leaf。

索引读取以字节事实和修订保护增量处理，部分尾行等待，完整损坏行报告。只读预览在内存规范化并投影，不能调用可能写回源的打开流程。直接继续则先拒绝不支持的旧 header，避免打开时静默改变文件。

原生 Clone 由 Pi 决定新文件和 ID；复杂压缩/上下文编辑/分支保真需经独立原生 CLI 重开验证。Hub 不实现第二套树复制算法。

## 控制协议与生命周期

私有 socket 协议 2 使用认证材料、宿主 PID/启动身份/TTY、代次和递增序号。消息有长度边界，命令回执与查询可恢复同一请求。Hub 重启重新认证已登记宿主；宿主切换原生会话会发布新绑定。已连接状态属于该控制通道，不能用来判断普通外部 Pi 是否使用记录。

Terminal 适配器核对窗口/标签/TTY 和精确进程；Ghostty 核对承载窗口/标签/terminal surface。退出只关闭被选 surface，不关闭含其他分屏的父对象。核对失败返回错误，不按标题找近似目标、不向猜测 TTY 输入、不使用 blanket kill。

## 集成边界

- RPC 模式适于结构化独立客户端；RpcClient 会创建/停止自己的子进程，不附着已经运行的 TUI。选择理由见 [SDK 与 RPC](research/pi-rpc-sdk-managed-processes.md)。
- 原 cwd 不存在时显式选本次目录，不改 header/归属；原目录与运行目录在界面区分。
- 新的明确打开允许重复实例；同一 GUI 请求恢复只核对原动作。
- 内置 llama.cpp 支持不足时明确失败，不静默替换模型；不以 Hub 配置覆盖用户 Pi 资源。
- Terminal/Ghostty 的 AppleEvents、应用版本和本机安全环境属于真实 OS 边界，模拟错误只能证明错误处理，不能替代真实终端或系统授权交互。
