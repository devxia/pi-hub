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

## 当前安装基线

当前安装应用为 `/Users/xiabinbin/Applications/Pi Hub.app`，最近生产变更为 `75a3e1c`（侧栏“设置”文字）。包内/外部 Pi 为 1.5.2，67 个源码/配置文件与 7 个运行资产绑定。

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
