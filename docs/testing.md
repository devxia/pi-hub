# 测试与交付规则

## 版本与范围

新测试统一使用官方最新 Pi，当前核实为 1.5.2，包内与外部宿主版本一致，Node 24+。开始新验收时核对 npm latest、锁文件、实际外部安装和包内版本；版本变化先完成 API 兼容和真实集成验证，不使用旧版本得到新的通过结论。

| 入口 | 范围与使用时机 |
| --- | --- |
| `npm run test:quick -- {target}` | 修改单模块后过滤运行；真实临时 SQLite/文件可用，不启动 SDK/CLI/PTY 或 GUI。省略过滤执行全部 quick 用例。 |
| `npm run test:integration -- {target}` | SDK、CLI、PTY、shell 环境和 opt-in 规模探针；单 worker 串行，相关实现稳定后执行。 |
| `npm test` | quick + integration 的完整服务回归，交付前一次；原有用例不减少。 |
| `npm run check` | 类型、renderer 运行时依赖/Forge 白名单，以及门禁自身的负向测试；无 GUI。 |
| `npm run test:ui -- {target}` | desktop 项目的静默 Electron UI；加载正式应用资产，需明确自有 profile 与应用路径。 |
| `npm run test:ui:foreground -- {target}` | 显式前台的真实 .app 生命周期、激活、单实例与离仓库验证。 |
| `npm run test:native` | 独占、串行执行前台 .app 检查及原生选择器/快捷键/Terminal/Ghostty；需明确应用路径。 |
| `npm run package` | 稳定源码的双架构构建，结束时自动核对两份包；单架构命令只检查本次架构。 |

Vitest 的 quick/integration 两个项目共同覆盖 `tests/service/**/*.test.ts`。集成证据默认写入已忽略的 `.scratch/integration-tests/<run>/`，可用 `PI_HUB_TEST_EVIDENCE` 指定本次目录。集成文件明确列在 `vitest.config.ts`；新增 SDK/进程测试必须归入 integration，不能仅凭 service 目录名认定是快测。`tests/checks/` 使用 Node test runner 检查治理边界，不计入业务用例数量。`tests/fixtures/` 保存共享隔离、合成数据和清理辅助。

单模块先过滤快测；协议、文件写入或原生生命周期再补真实边界；界面文字/间距复用相关 UI 检查；文档只检查链接和事实。交付或跨模块改动运行完整服务回归，发布构建需通过实际包检查。没有新变更、失败或疑点时不重复已通过的矩阵；不为可逆的小改动新增镜像测试，不把历史矩阵算作本次通过。

## 业务验证入口

服务通过公开 SessionManagement、临时真实 SQLite 和合成原生 JSONL 验证。测试可在 OS/文件系统/进程边界制造失败，不伪造业务成功，不在生产增加测试开关。复杂分支、压缩和 context-edit 的结果用独立原生 CLI 再次打开，SDK 内存回读不足以证明互操作。

桌面测试必须先通过 `tests/fixtures/owned-electron.ts` 验证实际 argv 的自有 --user-data-dir，以及 canonical userData/HOME/agent/sessions 均属于本次临时根，再操作业务 UI。HOME 本身不隔离 Electron。该夹具在业务操作前将 Electron clipboard API 替换为内存边界；不读、备份、恢复或清空用户剪贴板。菜单成功/取消和断言失败都只影响该测试进程内存，未支持的剪贴板格式直接报错。复制仍通过真实 IPC/业务处理后断言完整 ID，不能据此宣称已验证真实 macOS 剪贴板传输。

测试 API 与真实 IPC/数据服务保持一致；原生菜单/目录选择的可控边界不替代业务验证。快测和静态门禁无 GUI。普通 desktop 项目通过测试 bootstrap 使用本仓库同版本 Electron 加载指定应用的正式 main/preload/renderer；保留原生 BrowserWindow 对象、真实 IPC、utility 和 SQLite，仅在 main 的原生窗口边界强制隐藏、禁止激活并拦截 show/focus。意外的原生弹窗或菜单必须明确提供 OS 边界，否则直接失败。每次关闭保存实际窗口的可见/焦点状态与 show/focus 违规记录，并检查 PID 清理。该路径是隐藏的真实 Electron renderer，不冒称执行了指定 .app 的启动器或完全没有图形进程。

真实应用激活、单实例、离仓库启动标记 `@foreground`，由 desktop-foreground 项目使用原可执行文件直接启动；原生选择器、快捷键和终端使用 native 项目。两者显式独占前台，不能称为静默验证。三个项目的用例集合互斥；普通命令不意外启动前台检查，`test:native` 串行包含 desktop-foreground 与 native。测试 bootstrap/窗口边界仅在 tests/fixtures，不在生产加入测试开关或业务成功替身。独立脚本可在 launchOwnedElectron 最后一个参数显式传 `{foreground:true}` 选择真实应用通道。

~~~sh
PI_HUB_TEST_APP="/absolute/Pi Hub.app/Contents/MacOS/Pi Hub" \
PI_HUB_TEST_EVIDENCE="/absolute/owned/evidence" \
npm run test:ui -- tests/desktop/settings-window-desktop.spec.ts
~~~

开发 Electron 还需 `PI_HUB_TEST_ENTRY` 指向入口；打包可执行文件不会按开发 Electron 的方式接受任意入口。静默 bootstrap 保持 appPath 和模块查找指向实际生产根，在运行记录中明确保存 requestedExecutable/productionRoot/mode；不能据此声称测试了正式可执行文件启动。单实例、离仓库启动和安装验证使用实际 .app 的显式前台入口。默认双架构包位于 `dist/packages/Pi Hub-darwin-x64/` 与 `dist/packages/Pi Hub-darwin-arm64/`，把当前 Mac CPU 对应的可执行文件传给 `PI_HUB_TEST_APP`，不默认依赖 Rosetta。desktop-foreground 中的 standalone 用例验证离仓库运行，执行整组或 test:native 前应将整份 .app 复制到自有仓库外目录、核对 ASAR 一致后，传入复制后的绝对可执行文件路径；仅过滤生命周期用例时不要求该复制。交叉打包检查目标 Mach-O、原生模块和包内容，实机运行结果按 x64/arm64 分开记录。原生菜单快捷键使用真实 OS 键盘路径，不以 CDP 键盘证明应用菜单加速键。

## 原生与故障边界

实际 Terminal/Ghostty 流程在独占的串行阶段运行：

~~~sh
PI_HUB_TEST_APP="/absolute/Pi Hub.app/Contents/MacOS/Pi Hub" \
PI_HUB_TEST_EVIDENCE="/absolute/owned/native-evidence" \
npm run test:native
~~~

`test:native` 先核对 npm latest 与锁定/安装的 Pi，然后串行执行 Ghostty split 的 Vitest 检查，以及 desktop-foreground 的实际 .app 检查和 native 的目录选择器、Cmd+Q、Terminal/Ghostty Playwright 检查；只面向明确传入的应用路径，未指定时直接报错。需要单独发现用例时使用 `PI_HUB_TEST_NATIVE=1 npx vitest list` 或 `npx playwright test --project=native --list`，发现不等于执行通过。普通 `test:ui` 不包含原生项目。规模检查仍需显式设置 `PI_HUB_SCALE`，不在常规命令中自动开启。

测试的 SDK、CLI、启动器及 Node 路径统一由 `tests/fixtures/pi-installation.ts` 解析本仓库锁定安装；不保存开发者的绝对安装路径。新验收先调用该辅助的 latest 核对，官方版本变化时明确失败，先升级并验证兼容。

宿主使用合成记录、自有 agent/settings/扩展和本地确定性 provider；不读真实对话或凭据，不调用付费模型，不全局安装测试扩展。shell 变量用合成值验证，不输出真实值。TCC 不重置、不自动批准、不降级 Pi、不 blanket kill。

核对精确 PID/启动身份/TTY 和原生对象后清理，保留基线窗口、其他标签页、Ghostty 父对象及分屏。退出测试包括忙碌取消/确认、记录保留、清理期间可读取工作区。已完成副作用与回执丢失、源替换、权限失败、不可用来源要分别验证。

模拟 AppleEvents -1743 能验证错误处理；真实原生操作能验证当前权限下的路径；两者都不能冒称第一次系统拒绝交互。opt-in 规模或 split 探针未运行时明确 skipped。

## 运行与证据

较长检查使用可持续的 runner，分开保存日志、退出码、版本和包绑定，避免短 shell timeout 中断套件。保留失败、被中止运行及后续修正的区别；重跑通过不能删除失败事实或证明根因。cleanup proof 不完整时报告缺口，可用 OS 精确审计确认已记录进程不存在，不能倒填 fixture 证明。

视口截图等待真实内容和动画稳定，并核实实际主题。拖动测试在原生鼠标释放前读取插入线，动画记录调用真实实现；处理构建 CSS 的 ms/s 单位。reduced-motion 核对 CSS 和脚本均无活动动画。性能采样声明记录量、设备及观察边界，不承诺未经测量的 FPS/内存。

## 包与安装

`scripts/check-project.mjs` 使用现有 esbuild 解析 renderer 的静态运行时 import/export/require/动态字面量依赖，拒绝 Electron 与 Node builtin；注释、普通文本及已消除的 type import 不误报。这是直接依赖的工程约束，不代替 preload/IPC 的运行时权限验证。它也核对 Forge 白名单保留运行目录、排除开发目录、构建回执及递归包。

构建在 `dist/build-receipt.json` 写入源码、脚本、锁文件、配置、共享 token 与运行资产的哈希。`scripts/check-package.mjs` 拒绝构建后改动、ASAR 额外目录/文件或资产篡改，并核对清单、包内 Pi、Electron 主程序/Framework、SQLite 和 Pi TUI 的 CPU。`npm run package` 自动执行；已有包可运行 `npm run check:package -- --arch x64`，自定义根可传 `--packages-dir` 或 `PI_HUB_PACKAGE_OUT`。`tests/checks/` 包含违规依赖、错误 CPU、资产/源码改动及嵌套输出的负向样本。

生产源码稳定后构建一次。构建回执说明当前输入与包一致，不冒称独立重建证明；需要交付独立重建证据时另行比较运行资产。静态 CPU 核对不证明 arm64 实机或 Rosetta 行为。退出精确安装实例后检查文件占用，阶段复制/替换、保留回滚，再用自有 profile 从安装路径验证。真实 Hub 数据与原生会话不用于测试。

安装前后比较实际 profile 普通文件，记录已知测试进程清理；应用更新不能清数据或终止外部 Pi。结果进入[版本化验证记录](validation.md)。开发过程实验与原始回执是取证材料，不是默认测试入口或现行产品契约。
