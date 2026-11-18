# 验证记录与边界

本页是已执行验证的统一解释入口。产品规则见[产品规格](product-spec.md)，执行方式见[测试规则](testing.md)。以下结果绑定各自源码/包，不是当前 HEAD 全套重跑结论；后续仓库整理的测试结果另行记录，不代表重装了用户应用。

原始回执目录 `.scratch/` 被 Git 整体忽略，只保留在执行验收的本机。下文用代码路径标注本机取证位置，路径以仓库根目录为起点，不作为可在仓库中打开的链接。新检出不包含这些原始文件，本文仍完整保留版本、数字、失败与限制；新运行按下列命令生成自己的结果。

## 在新检出中验证当前版本

以下命令验证当前工作树，不能补称重新取得了表内历史包的结果。需要 macOS、Node 24+ 和与官方 latest 一致的 Pi；若版本核对失败，先升级并验证 API 兼容，不改用旧版测试。安装依赖后先运行无 GUI 的检查：

~~~sh
npm ci
node --input-type=module -e "import { verifyLatestPi } from './tests/fixtures/pi-installation.ts'; console.log(verifyLatestPi());"
npm run check
npm test
~~~

发布包运行 `npm run package`，会生成并检查 x64/arm64 两份应用。只验证本机架构时，Intel 用 `npm run package:x64`，Apple Silicon 用 `npm run package:arm64`。正式验包入口会核对构建输入、运行文件、包内容和原生模块 CPU；它不证明 ARM 实机运行、签名公证或独立重建。

普通 UI 使用同版本 Electron 加载正式应用资产，在测试层隐藏窗口及禁止激活，并预检自有 profile。以下是 Intel 包的相关 UI 示例；Apple Silicon 把路径中的 `darwin-x64` 改为 `darwin-arm64`。测试夹具自行创建并预检临时 HOME/agent/sessions/userData，不能指向实际会话和实际 Hub 数据：

~~~sh
PI_HUB_TEST_APP="$PWD/dist/packages/Pi Hub-darwin-x64/Pi Hub.app/Contents/MacOS/Pi Hub" \
PI_HUB_TEST_EVIDENCE="$PWD/.scratch/verification/current/desktop" \
npm run test:ui -- tests/desktop/settings-window-desktop.spec.ts tests/desktop/session-menu-desktop.spec.ts
~~~

运行完整静默桌面项目可去掉文件过滤。实际 .app 的激活、单实例及离仓库检查使用 `npm run test:ui:foreground`；真实选择器、Cmd+Q 和 Terminal/Ghostty 也需独占前台。执行完整前台组或 `test:native` 前，将本机架构的整份 .app 复制到自有仓库外目录并核对 ASAR 一致，把复制后的可执行文件与独立证据目录传入；离仓库用例会核实实际 appPath。`test:native` 会再次核对 latest 并串行执行 desktop-foreground/native 项目。静默结果不冒称正式可执行文件启动或真实系统焦点验证。规模探针仍是 opt-in，未启用必须记为 skipped；更多故障、隔离及清理约束见[测试规则](testing.md)。

每次验收自行记录 commit 和未提交差异、Pi/Node/macOS/终端版本、包哈希、命令与退出码、跳过和失败、cleanup proof 及限制。集成默认生成 `.scratch/integration-tests/<run>/`，UI 使用上述显式目录。保留本机原始日志；如需向其他人提供原始回执，应另行提供经检查的构建产物或附件地址，仓库目前没有已配置的公共 CI 证据服务。

## 2026-11-17 静默 UI 与双架构产物同步

在保持生产 `src/` 62 文件不变的前提下，把普通 UI 改为测试启动层加载正式资产的隐藏 Electron；没有生产测试成功开关。先用设置草稿/关闭/退出流程验证，再执行全部 36 项静默 UI，均通过。显式使用仓库外相同测试包的 3 项前台 .app 检查也全部通过，覆盖激活、单实例、正常退出及数据库迁移/不兼容保护。原 Playwright 42 项保持为 desktop 36 / desktop-foreground 3 / native 3；本轮没有重新运行真实选择器、快捷键、Terminal/Ghostty 或完整服务矩阵。

类型与项目门禁、7 项工程边界检查通过；官方 latest/锁定 Pi/测试包内 Pi 均为 1.5.2。稳定输入重新生成 x64/arm64，并统一通过每包 72 输入、10 运行资产及四类目标 Mach-O 检查，解决先前仅重建 x64 留下的 ARM 旧产物。没有 Apple Silicon 实机、签名公证或独立重建结论。

正式静默矩阵的 49 份隐藏窗口回执没有 show/focus 违规；静默矩阵运行期间按约 250ms 间隔取得 901 次 macOS 前台进程采样，未采到测试主进程。采样不能单独排除间隔内的瞬时事件，另以原生窗口事件及 isVisible/isFocused 记录核对。55 份已记录启动、54 份 cleanup proof，另有显式生命周期退出的 runtime metrics；277 个已知 PID 均不存在。试点第一轮启动超时未形成夹具证明；随后分别发现不可重定义原生 Electron 导出、BrowserWindow 子类影响静态窗口查询，修正测试启动层后通过，失败原始记录保留。

原始阶段结果（本机：`.scratch/pi-hub-quiet-ui/evidence/accepted/results.json`）、包结果（本机：`.scratch/pi-hub-quiet-ui/evidence/packages.json`）及最终审计（本机：`.scratch/pi-hub-quiet-ui/evidence/final-audit.json`）保留。原有暂存条目、已批准 README/资产及实际安装应用不变；未提交、推送或安装。

## 2026-11-17 可读性与文档可移植性

本轮整理了 59 个 `src/` 代码文件，未拆模块或调整逻辑。隔离使用 Prettier 3.10.1 并保留原始 JSX 文本节点；60 个 TS/TSX/MJS 文件在同一 esbuild 转换参数下的规范化 JavaScript 输出逐字节一致。CSS、HTML、正式 token、依赖、脚本和测试夹具保持不变。三个入口的最长行从 3529/727/946 字符降到 144/100/128 字符，SQL 等原有字符串保留。

官方 latest、锁定安装、外部 Pi 和测试包内 Pi 均为 1.5.2，Node 24.16.0。类型/工程及 6 项门禁测试通过；完整服务 131 通过、规模探针 1 项按 opt-in 跳过；Intel 测试包通过 72 个输入/10 个运行资产及目标 CPU 检查，相关真实 Electron 桌面 10 项全部通过，覆盖深浅/窄窗、排序、项目重开、生命周期、数据库失败、IPC、菜单和设置草稿。本轮没有重跑完整原生终端矩阵或 ARM 实机，没有安装新包。

29 个仅在本机存在的证据链接改成代码路径，并保留原有版本、数字、失败与限制。22 个正式 Markdown 的 88 个仓库本地链接不再依赖 `.scratch` 是否存在；上方命令用于新运行，不代表已在全新检出或公共 CI 上执行本轮验收。原始结果和核对位于本机 `.scratch/pi-hub-maintainability/evidence/`；已有暂存内容、README/资产、固化更新设计和安装应用保留，未提交或推送。

## 设置文字版本安装基线

该阶段安装应用为 `/Users/xiabinbin/Applications/Pi Hub.app`，最近生产变更为 `75a3e1c`（侧栏“设置”文字）。包内/外部 Pi 为 1.5.2，67 个源码/配置文件与 7 个运行资产绑定。

ASAR SHA-256：`3e35ed342c69bac3bf08cf1e91ed6573e0c126e8d06d08319130f3463a5a6573`。文档和样板整理不等于重做生产绑定；文件时间/文档注释变化也不能伪称已重新打包。

## 测试治理与正式门禁验证

2026-11-17，在现有未提交整理上完成剪贴板隔离、测试执行分层和正式工程/验包入口，生产 `src/` 的 62 个文件及当前安装应用未变。官方 latest、锁定安装和包内 Pi 均为 1.5.2。原有服务用例 131 项不变，分为 **quick 121 通过、integration 10 通过**，规模探针按 opt-in 跳过；Playwright 用例发现前后均为 42 项。本次没有重跑全部桌面或真实系统终端矩阵。

类型检查、renderer 直接运行时依赖/Forge 白名单检查、6 项门禁负向测试通过。实际生成 x64/arm64 包，正式脚本每包核对 72 个构建输入、10 个运行资产及 Electron/Framework/SQLite/Pi TUI 的目标 CPU。Intel 菜单 UI 1 项通过，覆盖取消不写入、完整 SessionID 复制及目标绑定；剪贴板调用在内存完成，不宣称验证了真实 macOS 剪贴板传输。没有 Apple Silicon 实机运行或独立重建结论，未安装新包。

首次验收因继承的失效本机代理而未能查询 npm，子进程临时去掉代理后重新核实 latest；未改用户配置。首次直接集成入口暴露证据目录未默认配置的问题，修正执行配置后 10 项通过。工程门禁自身也保留首轮路径处理失败及修正记录。原始验收（本机：`.scratch/pi-hub-governance-fixes/evidence/acceptance.json`）、包结果（本机：`.scratch/pi-hub-governance-fixes/evidence/accepted/packages.json`）及最终核对（本机：`.scratch/pi-hub-governance-fixes/evidence/final-audit.json`）在本机保留。

## macOS 双架构打包验证

2026-11-16，在上述未提交整理上增加 x64/arm64 构建入口。`npm run package` 实际生成两份应用；随后单独执行 `package:arm64`，x64 包哈希保持不变。默认输出 `dist/packages/`，整个 `dist/` 已忽略。包内不含旧包、测试或本机证据；每份包的 10 个编译文件（含 sourcemap）与当前构建一致，Electron 主程序/框架、SQLite 和 Pi TUI 模块均为相应 CPU。

Pi latest/锁定/实际安装为 1.5.2。类型检查、1 项应用身份服务检查、Intel 包的 4 项相关桌面检查通过；覆盖项目保存与重开、单实例、数据库失败和 IPC。没有重复全套业务或原生终端矩阵。5 份自有启动记录、4 份 cleanup proof，另有显式退出的 runtime metrics；26 个已记录 PID 均退出，安装应用未变。

arm64 完成构建、CPU/依赖/包内容及代码签名数据核对，尚无 Apple Silicon 实机运行结果。Framework 原路径检查遇到时间预算；单独抽出的 Mach-O 缺少 Info 元数据，不能作为有效签名检查。最终以完整 Framework 的相同二进制和元数据副本验证通过；不宣称 Developer ID 签名、公证或 ARM 实机认证。阶段 结果（本机：`.scratch/pi-hub-dual-architecture/evidence/results.json`）、最终包（本机：`.scratch/pi-hub-dual-architecture/evidence/packages.json`）、单独构建（本机：`.scratch/pi-hub-dual-architecture/evidence/single-arm64/exit.json`）、最终签名数据（本机：`.scratch/pi-hub-dual-architecture/evidence/arm64-final-signatures.json`） 和 进程核对（本机：`.scratch/pi-hub-dual-architecture/evidence/audit.json`） 均为本机记录。

## 2026-11-16 仓库整理验证

2026-11-16，基于 `95e00d8` 的未提交目录整理，官方 latest、锁文件及实际测试 Pi 均为 1.5.2。生产 `src/` 的 62 个文件逐字节未变，未重装应用。现行测试搬入 service/desktop/native，框架用例清单没有丢失，新增一项原生选择器/正常退出测试接替旧独立脚本。

本轮类型检查、测试包构建通过；服务 **131 通过、1 项规模测试按 opt-in 跳过**；普通桌面 **39 通过**；显式原生阶段 **Ghostty 分屏 1 项、真实选择器/Cmd+Q 与 Terminal/Ghostty 3 项全部通过**。测试使用离仓库的同一测试包，包内 Pi 1.5.2 和 7 个运行资产已核对；不是对当前安装应用的重新验收。原始 阶段结果（本机：`.scratch/pi-hub-repository-layout/evidence/verified/results.json`）、用例比对（本机：`.scratch/pi-hub-repository-layout/evidence/inventory-comparison.json`） 和 最终核对（本机：`.scratch/pi-hub-repository-layout/evidence/final-audit.json`） 仅在本机保留。

## 按实际交付解释的证据

| 源码阶段 | 实际检查 | 本机取证路径（不随仓库分发） |
| --- | --- | --- |
| 75a3e1c 设置文字 | 首次初始读取超时；同包同断言预算后续 1 项通过，安装路径 1 项通过。14 个已知测试 PID 不存在，11 个实际 profile 普通文件未变；未跑全套 | acceptance（本机：`.scratch/pi-hub-settings-label/evidence/acceptance.json`） / 安装日志（本机：`.scratch/pi-hub-settings-label/evidence/installed/run.log`） |
| 1ea30b9 清爽秩序 | 相关矩阵 10 通过/1 指示线采样失败；同生产包 held-drag 后续 1 通过，合计 11 个不同用例。安装 4 项通过，非单轮全绿；未重跑全服务/原生/规模矩阵 | acceptance（本机：`.scratch/pi-hub-clear-order/evidence/acceptance.json`） / 交付门槛（本机：`.scratch/pi-hub-clear-order/evidence/accepted/delivery-gate.json`） |
| 34a14c6 统一设置与最新 Pi | Pi 1.5.2 服务 131 通过/2 opt-in 跳过；普通桌面首轮 31 通过/5 失败，后续 5 原失败项均通过，共 36 不同用例；真实 Terminal/Ghostty 各通过，安装 6 项通过，原生快捷键通过。不是单轮全绿 | acceptance（本机：`.scratch/pi-hub-unified-settings/evidence/acceptance.json`） / 完整首轮（本机：`.scratch/pi-hub-unified-settings/evidence/accepted/desktop/run.log`） / 后续（本机：`.scratch/pi-hub-unified-settings/evidence/outside/results.json`） |
| 2d8df7d 原生菜单与退出 | 最终 SIGTERM 路径相关服务 7 项、桌面 6 项、真实 Terminal/Ghostty 2 项、安装 6 项通过；另实测保留兄弟 Ghostty split 和 Terminal 标签/进程。先前全服务 131/完整桌面 34 在退出细化前，不算最终全量 | acceptance（本机：`.scratch/pi-hub-session-menu/evidence/acceptance.json`） / 最终结果（本机：`.scratch/pi-hub-session-menu/evidence/accepted/results.json`） |

较早包的索引 SDK 版本与随后统一版本不同，其原始数据只证明当次运行；新测试执行最新版本。其他阶段原始 JSON/log/截图留在其 evidence 目录供事实取证，不再用各阶段说明作为产品规格。

## 原生兼容与安全证据

原生 SDK 结果包括 /name/清空、Clone 切换、新对象绑定、Hub 退出/重连、任务忙碌退出、交互 shell 合成环境、真实终端定位和对象保留。复杂历史用独立普通 Pi CLI 重开验证：简单分支（本机：`.scratch/pi-sdk-client/evidence/services-contract/sdk-native-simple/result.json`）、复杂历史（本机：`.scratch/pi-sdk-client/evidence/services-contract/sdk-native-complex/result.json`）。这些是其阶段结果，不扩展为新平台认证。

已验证本机环境为 macOS 15.7.7/24G720 Intel、Node 24.16.0、Terminal 2.14、Ghostty 1.4.0。没有 iTerm2/tmux/screen/SSH、其他版本、签名/公证/安装器/自动更新认证。系统授权证据区分真实生产事件和受控 -1743，不宣称重新操作了首次系统拒绝。

## 清爽秩序与性能

真实 Electron 检查覆盖 1440 浅色、1100 深色、860 覆盖预览、设置 860/680、内容/身份展开、原生菜单及展示顺序。8 个合成文件字节不变；过滤移动保留隐藏记录顺序，重开后可用手动排序，减少动态效果没有活动动画。

实际 held-drag 检查得到正确上下插入线，3 个真实 WAAPI transform 动画为 220ms。构建后 CSS 秒单位解析缺陷已在生产修正；指示线采样测试与修正前失败保留：单位诊断（本机：`.scratch/pi-hub-clear-order/evidence/final/animation-unit-diagnosis.json`）、修正后验证（本机：`.scratch/pi-hub-clear-order/evidence/accepted/drag-held-followup/design-layouts.json`）。8 条数据和动效属性检查不能保证大数据 FPS/CPU/内存。

50 项目/10000 非空会话、普通更新 p95 约 2 秒是当前目标，未在当前包重新基准测量。更早性能原始运行可供调查，但不能套用到当前架构、所有采样或新功能。

## 保留的失败与未知

已有初始项目读取/预览超时、一次 utility 中断、搜索输入少最后字符和导入重启等待超时。相同包后续通过及三次启动诊断无 stderr/正常退出没有证明根因，也不证明运行位置导致差异。一次首个预览计时约 9146ms，后续 5/4ms，仅为观察。部分新测试修正为已有 15 秒后台预算，生产超时未因此改变。

原始机器上下文保留为数据：设置启动（本机：`.scratch/pi-hub-settings-label/evidence/settings-startup-failure.txt`）、插入线采样（本机：`.scratch/pi-hub-clear-order/evidence/accepted/indicator-sampling-failure.txt`）、动画单位（本机：`.scratch/pi-hub-clear-order/evidence/final/animation-failure-context.txt`）。重跑成功不能把上述未知改写成生产故障已修复。

所有普通数据保持/进程清理数字也按各次回执解释。例如统一设置 100 个启动记录中 96 份 fixture cleanup proof，最终 OS 审计确认 491 个已知 PID 均不在，但不能补称 100 份完整证明。清爽秩序为 64/64 份、320 个已知 PID 不在。不是对全部用户进程的扫描或承诺。

## 文档维护

检查只在实际重新执行后追加当前版本结果。被替代的产品决策、阶段规格/issue/提案及文字报告从工作树删除；原始回执按上述版本边界保留。此次整理的路径清单与静态结果在整理清单（本机：`.scratch/pi-hub-docs-consolidation/manifest.json`）和检查结果（本机：`.scratch/pi-hub-docs-consolidation/checks.json`）。

## 2026-11-17 远端工作区首次交接（父审拒绝，历史记录）

本次以 main `8bde422557419dc2d7047409ade22d2490c98ce1` 为基线，实施 M1/M2/M3 及普通 Linux/Slurm 双 adapter；不是整体功能验收。正式契约见[远端工作区](remote-workspace.md)与 ADR0007，原提案的原文保存在本机 `.scratch/pi-hub-remote-workspace/evidence/approved-plan.md`，当前正文不再保留被替代的正式提案。完整交接、逐项实施/测试矩阵与失败回执索引在同目录 `development-report.md`。

最终源码检查 `check-quit-fix` 通过类型、项目策略及 7 项治理检查；过滤 quick `remote-contract` 18 项通过；显式 integration `remote-boundaries remote-ssh` 13 项通过。独立运行的 `full-isolated` 为 23 文件、162 测试通过，另有原有 opt-in scale 1 项跳过，未新增 skip/移除/放宽原断言。`package-quit-fix` 双架构及自动验包通过。精确 x64 包资产在 unchanged owned quiet harness 中运行四个 desktop 目标，共 6 测试通过：工作区、实际 unpacked CLI、已有 settings、已有 terminal choice。CLI 在仓库外 cwd 经 Node24 和精确 owned profile 运行，拒绝过期/撤销/越界/自批/相同 request 不同摘要/包篡改，并核对 Hub 停止时不可用。篡改后恢复原字节并再次验包通过。

实际检查 light/dark、1440/860、原生 modal 背景 inert、Escape/Tab/焦点恢复、错误保留和 Slurm 草稿审核截图；精确 utility SIGKILL 时的自有 blackhole SSH 被主进程按持久 PID/启动身份清理，新 generation 在旧 writer 退出后建立。失败的首个 UI 缺可执行路径、早期 dist 重建竞态、合成包 fixture/ASAR unpack 模式、开发期间字段/类型错误、modal 测试时序均保留。已有 terminal choice 测试发现真实 `/var` 与 `/private/var` profile 导致退出误报远端未决的回归；已修复 canonical profile，并避免仅退出时新建从未打开的 remote DB，原测试不改即通过。一次与 UI 并行的 full run 中，原 discovery-work 在原 5000ms 限制超时；串行隔离重跑全部通过，原测试及超时均未调整。

核对 npm latest/包声明/锁/本机依赖/外部安装版本元数据/双架构包均 Pi 1.5.2，Node v24.16.0（`/usr/local/bin/node`），Electron 45.2.3，Darwin x64。未升级全局环境、安装应用、连接真实用户服务器或读取真实配置/密钥/会话/凭据。原 quiet fixture 的原生隔离与精确 PID 清理保持。

最终构建 receipt SHA-256 `1932c03b2acf6a66d21ed3707252df896dbe39c1644560aa01cd0edb74052409`，源码输入 aggregate `bdc59c34d976e0ca66d9f1235983c5e820033995541f5fd756422d38a781fa25`；x64 ASAR `e4d9fa97f894a14b1ad4a981435ada1069bcabfbe4256742b80c2fc5c0eb7a55`，arm64 ASAR `1fa44abb7261a543d9eaa37ecc0b3ce033b8436eaa3419e4c7eb6a87c50dd3e3`。完整 per-file receipt/pins、双架构 CPU 校验、实际命令 argv/cwd/退出码/时间及旧失败见本机 evidence；源码输入已移除生成的 Python cache。文档/测试时序更正另由工作树记录。

真实 Linux 最后登录退出保留、完整 subreaper/TERM/KILL/ECHILD/崩溃/自然完成竞态、Slurm controller 的受约束取消/JobID 复用/提交接受断点尚未有授权环境运行，对应能力保持关闭。普通 Linux/Slurm 写 adapter 已实施但端到端未验证；不能将语法、包或 GUI 草稿通过当成远端运行成功。首次交接当时缺少自动化远端能力验收/receipt 工具；父审因此及流式 SFTP 等范围缺口拒绝交接。此历史结果不能作为修订后源码的验收，现行工具契约见 remote-workspace.md 第 10 节。首次交接未运行实际 arm64 硬件或前台安装 .app 验收。

## 2026-11-18 远端工作区第二轮修订

源码基于 `8bde422557419dc2d7047409ade22d2490c98ce1`。本轮单独取证在 `.scratch/pi-hub-remote-workspace/evidence/revision2/`，包括命令 argv、退出码、时间、完整日志、构建收据和仓库外包校验。Pi 最新版、声明、锁、依赖、外部 CLI 及双架构包均为 1.5.2。本机为 Intel macOS，Node 24.16.0，Electron 45.2.3。

`check-final` 类型、项目策略及 7 项治理检查通过。`quick-final` 2 文件、21 项通过；`integration-final` 4 文件、29 项通过。通过正常入口检查 retained fd 读取契约、异步审核的稳定 ID、1,101 项精确清单分页、过期与重启清理、真实回环 SFTP 的中断计数与完整发布、Agent CLI 的历史项目范围、延迟响应下的新状态保留。初次 integration 的 fixture 误传普通路径导致 1 项失败，原始回执仍在 `runs/integration-initial/`。

`package-final` 与 `check-package-final` 验证 Intel 和 arm64 macOS 包。构建收据 SHA-256 为 `85f18239992387f2bba6fddfd4cefde0a7a1fed786d7c60e644a75bfc6f6cc62`，95 项输入的聚合值为 `f0627d57d81dae3052a4b299edf7a6d22d92fa99c23033b3bcd6ddbfc04ba20b`。x64 ASAR 为 `9f669ac0016675e9972290c864967e19732ebc81b6ff4752171104ddad6bf80b`，arm64 ASAR 为 `10a1afd71dae313b60ca26fd1f94da177492f13626ead2fbf5a506c0c4cce43c`。`outside-package.json` 记录两份仓库外副本的逐包 CPU、21 项运行资源及实际解包 CLI 校验，arm64 Electron 未在 Apple Silicon 运行。

`full-final` 26 文件、181 项通过，既有 opt-in scale 1 项跳过。静默运行用同一精确 x64 包，`ui-final` 6 项通过、2 项失败。修正 CLI 测试的 JSON 包装读取与窄布局测试的切换等待后，`ui-followup` 原失败的 2 项通过。静默证据合计 8 个不同用例，来自两次运行。`foreground-final` 使用仓库外 x64 `.app` 可执行文件，3 项通过。桌面篡改测试恢复原字节后，`check-copy-restored` 两份仓库外包再次通过，ASAR 摘要与本轮收据相同。

本机 runner 测试包括实际持有的目录描述符和合成 Slurm 协议输出。真实 Linux `/proc`、最后 SSH 登录退出后的保留、scope/reaping 与信号生命周期，以及 Slurm controller 提交恢复、身份和取消矩阵仍须在另行授权的环境执行。本轮没有发布远程 verified 能力。

独立复测使用同一份最终源码和应用包。远端协议、流式 SFTP 和操作边界共 3 文件、28 项通过。仓库外 Intel 应用包的工作区、实际 Agent CLI、设置窗口及终端选择在一次静默运行中 8 项全部通过。9 份清理回执记录的 50 个 Electron 进程身份均已结束。复测前后均校验了仓库外两种架构的应用包，95 项构建输入、21 项运行资源及两个 ASAR 摘要与本轮构建收据一致。本机汇总记录在 `.scratch/pi-hub-remote-workspace/evidence/parent-acceptance/acceptance.json`。

本机已将验收通过的 Intel 包安装到 `~/Applications/Pi Hub.app`。从安装路径使用自有 profile 实际启动并通过数据库迁移测试，安装包资产通过「远端任务」入口与本地审核流程测试。安装包摘要及 21 项运行资源复核一致，实际 `~/.pi-hub` 下 10 个顶层普通文件的摘要一致。安装与启动回执见本机 `.scratch/pi-hub-remote-workspace/evidence/local-install/verified.json`。

## 2026-11-18 Pi Coding Agent 默认联动

独立服务回归 26 文件、181 项通过，原有 opt-in 规模探针 1 项跳过。类型、项目策略和 7 项治理检查通过。官方 latest、锁定安装、外部及双架构包内 Pi 均为 1.5.2，本机 Node 24.16.0、macOS 15.7.7 Intel。

仓库外 Intel 包的 7 项相关静默桌面检查一次通过。新增测试从「在 Pi 中打开」出发，在受控 AppleEvents 拒绝后使用实际手动启动命令，以自有 PTY 启动 Pi SDK 和 TUI。确定性本地模型调用内置工具，验证项目目录、自动关联、发起提交审核、GUI 拒绝、`/new` 后通过 Pi 选择另一任务，以及旧操作回执越界时被拒绝。未生成 CLI 启动器，预置版本后的自有 Pi 设置字节一致。实际解包的外部 Agent CLI 与原终端选择流程也通过回归。8 份窗口及清理回执未记录窗口激活违规，已记录的 Electron、PTY 和本机回环 SSH 测试进程均已退出。

首轮原生测试最后的设置断言失败，因为 Pi 首次启动写入 `lastChangelogVersion`，测试预置该值后通过。首轮完整服务运行有 179 项通过、2 项失败。周期取消测试缺少取证目录，重启后扫描重叠来源测试超过原 15 秒预算。准备好目录后，单独运行完整服务套件通过，两项测试的断言和超时保持原值。

双架构各核对 95 项构建输入及 21 项运行资产，仓库外 Intel 副本在 CLI 完整性检查前后匹配。构建收据 SHA-256 为 `bd4a387fdccf6156b08f9767d47b4a4702ca789e937f9d074dbb09fe385cbe7d`，x64 ASAR 为 `7ba3d217e77332371477264d1ea0cdb9862f0f5327625b1899049cdcf6aa9df8`，arm64 ASAR 为 `1318fd209474a36c12d78fd753d3747fff4297d96d67a67501d85fc334d01b20`。本轮未重新验证 Terminal/Ghostty 系统控制、真实 Linux 或 Slurm 作业及 Apple Silicon 实机。本机回执与首轮失败位于 `.scratch/pi-hub-native-remote/evidence/acceptance.json` 及同目录 `runs/`。

应用户要求，将上述 Intel 包更新到 `~/Applications/Pi Hub.app`，并复核安装位置的 ASAR、95 项构建输入和 21 项运行资产。使用隔离配置从该位置实际启动，数据库迁移检查通过；安装包资产中的「在 Pi 中打开」及原生联动检查通过。`~/.pi-hub` 下 10 个顶层普通文件摘要一致，3 份 Electron 清理回执和 PTY 记录对应的 18 个进程身份均已结束。安装回执见本机 `.scratch/pi-hub-native-remote/evidence/local-install/verified.json`。

## 2026-11-18 远端工作区服务器侧栏

将当前渲染器构建到已验收 Intel 应用的临时副本，用隔离配置运行远端工作区的 4 项桌面检查，全部通过。核对空态、按名称和主机搜索、清除搜索、两个菜单的位置、键盘选择、弹窗关闭后的焦点返回，以及浅色、深色和窄窗。首轮截图发现弹出菜单偏移到窗口左上角，显式绑定到各自的按钮后复测通过。4 份静默窗口记录无激活违规，24 个 Electron 进程身份及回环 SSH 测试进程均已退出。已安装应用的 ASAR 摘要复核一致。

`npm run check` 的类型、项目策略和 7 项治理检查通过。服务回归 26 文件、181 项通过，原有 1 项可选规模探针跳过。使用当前 Pi 1.5.2、Node 24.16.0。截图和测试回执位于本机 `.scratch/pi-hub-remote-sidebar/evidence/`。

随后构建 Intel 和 Apple Silicon 两份应用，各核对 96 项构建输入、21 项运行资产与目标 CPU。将 Intel 版更新到 `~/Applications/Pi Hub.app`，安装后的 ASAR SHA-256 为 `d94e7fb2f3e96a945ac5a9c04d031f043cf15ad6f99eb876c24c6b6c0b2aaf9c`。使用隔离配置从安装路径实际启动，数据库迁移检查通过。安装包资产的 4 项远端工作区桌面检查全部通过。`~/.pi-hub` 中 11 个顶层普通文件的摘要一致，记录的 34 个 Electron 进程与 1 个回环 SSH 测试进程均已退出。安装回执见本机 `.scratch/pi-hub-remote-sidebar/evidence/local-install/verified.json`。

## 2026-11-18 默认 SSH 配置导入

对隔离 HOME 中的 `~/.ssh/config` 从正式 Intel 包中验证默认配置缺失提示、直接预览别名、跳板缺项提示、连接字段和 `~/` 路径预填，以及取消后不新增服务器且配置文本不变。继续验证原有选择文件和粘贴入口。远端工作区 4 项静默桌面检查通过，4 份窗口回执未记录激活违规，24 个 Electron 进程与 1 个自有回环 SSH 进程均已退出。

Pi 最新版 1.5.2、Node 24.16.0。过滤快测 21 项通过，类型、项目策略和 7 项治理检查通过。完整服务回归 184 项通过，1 项原有可选规模测试跳过。Intel 构建核对 97 项输入、21 项运行资产，ASAR SHA-256 为 `a836c049c1c1992097d23968d878da668ed27799df5913984af1307823ae5a5f`。原始运行数据和构建路径见本机 `.scratch/pi-hub-default-ssh/evidence/acceptance.json`。

将同一 Intel 构建更新到 `~/Applications/Pi Hub.app`。安装后核对包内容和 ASAR 摘要，使用隔离配置验证安装路径的实际启动和数据库迁移，并从安装包资产复测默认 SSH 配置预览及文件选择流程，两项桌面检查通过。`~/.pi-hub` 中 10 个顶层普通文件的摘要一致，记录的 16 个 Electron 进程均已退出。安装回执见本机 `.scratch/pi-hub-default-ssh/evidence/local-install/verified.json`。

### 默认 SSH 预览兼容主机公钥选项

使用合成配置复现了 `StrictHostKeyChecking` 导致别名无法预览。修正后，含 `StrictHostKeyChecking no`、`UserKnownHostsFile /dev/null` 的别名可以导入，服务器表单的主机公钥字段仍为空，首次连接的指纹须明确核对。Pi 1.5.2、Node 24.16.0，21 项过滤快测、7 项治理检查及 184 项服务测试通过，1 项可选规模测试跳过。

Intel 修正包的 97 项构建输入和 21 项运行资产已核对。安装至 `~/Applications/Pi Hub.app` 后，实际应用启动检查、默认配置导入检查和自有回环 SSH 指纹确认检查均通过。安装 ASAR SHA-256 为 `595fded2a2773167140c573aa22270bac28ff006bbd17b0fe78db928c94596b0`。实际 profile 中 10 个顶层普通文件摘要一致，记录的 22 个 Electron 进程和 1 个回环 SSH 进程均已退出。原始复现和安装回执见本机 `.scratch/pi-hub-ssh-trust-import/evidence/`。

## 2026-11-18 本地与远端工作区栏宽调整

在隔离 profile 中使用合成会话和远端任务，验证了两条分隔线只改变相邻两栏、栏宽上下限、键盘调整和默认恢复、两个工作区分别记忆布局，以及缩窄后放宽和重新启动后的恢复。在 760、1050、1051 和 1440 CSS px 检查内容重排、拖动取消、详情切换、表单草稿和 Esc 后焦点。正式 Intel 包资产上的 7 项相关静默桌面检查通过，追加的预览连续性检查也通过。10 份清理回执确认记录的 58 个 Electron 进程已退出，另有 1 个隔离回环 SSH 进程退出。窗口回执未记录激活违规。

使用最新 Pi 1.5.2 和 Node 24.16.0。类型、项目策略和 7 项治理检查通过。完整服务回归 184 项通过，1 项原有可选规模测试跳过。Intel 包校验核对 98 项构建输入和 21 项运行资产，ASAR SHA-256 为 `501b6fc6562146119f765e56d961c323e66aa1120a4b1a1406c007ea29408a0b`。

同一 Intel 包已更新至 `~/Applications/Pi Hub.app`，安装后重新核对包资产和摘要。使用隔离配置完成实际可执行文件启动及迁移检查，并用已安装的包资产复测两套工作区的拖动和重启恢复，两项桌面检查均通过。实际 profile 中 10 个顶层普通文件的摘要一致，22 个记录的测试进程均已退出。安装回执见本机 `.scratch/pi-hub-workspace-columns/evidence/local-install/verified.json`。

首轮新增用例的拖动预期数值有误，修正后通过。中间包的一次远端工作进程重启检查及其测试清理超时，后续进程核对未发现该隔离根下的残留进程，最终包上的同项检查通过。原始运行日志、截图和包路径见本机 `.scratch/pi-hub-workspace-columns/evidence/acceptance.json` 及同目录各运行记录。
