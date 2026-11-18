# ADR 0007：独立远端 worker 与执行权威

状态：采纳。日期：2026-11-17。

SSH 和调度等待可以超过现有会话管理超时。远端任务也没有原生 Pi Session 的文件身份。将网络工作并入原串行管理队列会阻塞会话浏览；从 Agent 文本反推 JobID/PID 无法证明提交成功或安全取消。

采用独立 remote utility、独立 profile/remote/remote.sqlite 和单写入者。main 是唯一 worker 创建者，旧写入者退出并清理精确登记的本机 SSH PID/启动身份后才能替换。Operation 在返回前持久化 requestId 和命令绑定。异步固化输入后才发布不可变审批摘要，由界面按 ID 和摘要分页核对。generation/sequence 拒绝旧消息。崩溃后核对既有执行并清理中断的本地准备，提交与取消均不自动重放。现有 projects.sqlite v15 和原生 Pi 语义不变。

固定 Python RPC 通过受控 OpenSSH 配置承载有界控制 JSON，系统 OpenSSH SFTP 通过同一逐跳受控配置流式传输私有编号快照对象，分离控制响应与大文件字节。逐跳显式主机信任在任何探针之前完成，不运行导入 hooks。descriptor-relative N-API 处理本机输入和发布边界，远端 Linux 使用受控目录 fd。Slurm 用提交意图+唯一 marker 恢复，取消须稳定 SLUID 或已测试的 controller 全约束；Linux 用一次启动意图、长期 supervisor/helper、两级 subreaper、waitid WNOWAIT、持久 action intent 和串行信号门，不能以 nohup/PID 文件替代。完成、scope ended、取消原因分别记录。

M3 默认通过已登记的 Pi SDK 宿主提出当前会话与任务范围内的请求，其他 Agent 可通过私有 profile socket 和有时效的授权使用 CLI。可信主窗口审批精确摘要；两条入口共用远端 worker，数据库与 SSH 均由 Hub 管理。普通 Node 执行精确解包的 Agent CLI 和验收 CLI，私有 launcher 绑定 Node、CLI 和 profile。runner、supervisor、transfer、SFTP 与验收 Python 资源也随应用解包，由构建收据和运行时完整性校验绑定。独立验收工具只在显式授权合成环境执行真实生命周期/controller 检查并发布 schema=1、host/boot/资产/原始证据绑定记录；没有这些证据时相关远端写能力关闭；静态协议实现和真实远端验收分开报告。

代价是多一个 worker、数据库、native 文件边界和较严格的受支持配置范围。收益是会话服务不受慢网阻塞，未知副作用不会因恢复而重复，明确的预检阻止与结果未知分开记录，授权边界可由独立复核者检查。完整契约见[远端工作区](../remote-workspace.md)，实际结果见[验证记录](../validation.md)。
