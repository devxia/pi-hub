# Pi Hub 领域术语

| 术语 | 定义 |
| --- | --- |
| 项目（Project） | 按用户选择目录划定的组织范围，默认仅该目录，可包含子目录；词法路径重叠时归属最具体项目。 |
| 会话（Session） | 具有原生 Pi 身份的一份可继续对话记录，独立于进程、终端标签页及 Hub 分类。 |
| 会话名称（Session Name） | 对应原生 /name 的名称，允许重名及清空；不作为记录身份。 |
| 来源 / 会话存储位置（Session Storage Location） | 枚举 Pi JSONL 的标准或自定义位置，区别于会话工作目录。 |
| 源身份（Source Identity） | 精确源文件及原生头的身份与修订，用于避免向被替换对象执行动作。 |
| 导入（Import） | 对已发现历史选择主列表/归档分类，不复制、搬迁或转换原记录。 |
| 主列表（Active List） | 用户当前纳入日常查看的会话集合，不代表运行中。 |
| 归档（Archive） | 被管理但从主列表隐藏的分类；可手动恢复，新增可见对话时自动恢复，原文件保留。 |
| 只读预览（Read-only Preview） | 当前分支首条用户消息和最近三轮可见对话摘录，不提供发送消息。 |
| 展示顺序（Display Order） | 当前 profile 保存的手动列表顺序，当前页拖动/Option+方向键调整，不改变会话数据或时间。 |
| 运行实例（Running Instance） | 正在运行 Pi 的进程，可切换会话；会话在其退出后仍保留。 |
| Hub 宿主（Hub Host） | 由 Hub 启动、在外部终端运行 SDK/InteractiveMode 并提供控制连接的独立实例。 |
| 已连接（Connected） | 某个已登记宿主的 Hub 控制通道可用；不能据此判断普通外部 Pi 是否存在。 |
| 外部终端（External Terminal） | 承载 Pi TUI 的独立终端软件；当前认证 Terminal 和 Ghostty。 |
| 记录目录（Stored Working Directory） | JSONL header.cwd 保存的目录，是项目归属依据。 |
| 本次运行目录（Runtime Working Directory） | 某次实例实际工作目录；显式临时继续时可以不同于记录目录。 |
| 临时继续（Continue） | 原目录丢失后在用户选择的可用纳管目录运行原会话，保留 ID、原文件、header 和归属。 |
| 复制会话（Clone） | 用户确认后按原生 /clone 创建活动分支的新 ID，并切换同一运行时，原记录保留。 |
| 请求核对（Reconciliation） | 使用同一 GUI 请求身份查询原动作/回执，避免结果未知时重复副作用。 |
| 退出会话（Exit Session） | 正常停止选定可控实例并关闭精确终端对象；不删除会话。 |
| 删除会话（Delete Session） | 用户确认后优先废纸篓、失败再永久删除原文件并清除 Hub 条目/分类，独立副本保留。 |

完整行为以[产品规格](docs/product-spec.md)为准，架构定义见[文档入口](docs/README.md)。
