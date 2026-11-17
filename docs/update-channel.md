# Pi Hub 更新渠道设计

状态：**方案已固化，暂缓实施**。2026-11-17 用户明确要求保留本方案、暂时不实现；后续开始开发须有新的实施指示。当前产品没有应用内更新器，设置仍为三个类目，现有双架构构建不包含本页规划的更新发布流程。

本页是更新功能的完整设计依据，架构选择见 [ADR 0006](adr/0006-update-channel.md)。以下行为均为后续实施要求，不表示已经交付或完成真实升级验收。发布仓库、Apple Developer 条件与 Apple Silicon 实机验证仍待落实；无需为保存本方案立即提供账号或凭据。

## 1. 选定路线

保留现有 Electron Forge，接入已正式发布的 electron-updater MacUpdater，由 Electron/Squirrel.Mac 负责 macOS 签名验证、安装与重启。采用独立公共 GitHub Releases 仓库作为首版分发来源，源代码仓库可按用户需要公开或私有。所有用户端请求无需内置 GitHub Token。

首版规划提供稳定版（默认）和显式选择的预览版；不做 Magpie Every/Daily/Stable 的日历晋级机制，不建设自有更新服务、CDN 或下载镜像。现阶段没有足够发布频率支持每日、每周自动晋级；先采用版本 tag + 正式 Release / prerelease 的清晰规则。

更新默认行为：启动约十秒后后台检查，之后每六小时检查；可关闭自动检查；始终可手动检查。检查不自动下载，下载不自动重启，也不在普通退出时偷偷应用尚未确认安装的下载包。用户依次选择「下载更新」和「重启并安装」。

首次接入必须手动安装带 Developer ID 签名、公证与更新器的引导版本。现有本机 Pi Hub 未签名、没有更新器，不能把这次切换描述成可以从当前应用自行完成的升级。保持现有名称与 bundle ID `local.pi-hub.desktop`，后续发布保持兼容的开发者签名身份；首次从未签名切到签名包时 macOS 可能重新询问终端自动化权限，由用户正常授权，不重置或代替用户批准 TCC。

## 2. Magpie 对方案的启发

2026-11-17 只读检查的本机 Magpie 0.1.4341 具有 Developer ID 签名、公证票据。仓库实际使用 Go 自研更新器；源码与发布职责分离，Intel/ARM 分别出 ZIP/DMG，完整资产才公开。其站点渠道使用独立版本选择规则，镜像和 GitHub 是传输来源；客户端用内置公钥验证 Ed25519 签名的版本和 SHA256SUMS，再验证 app 签名。

可直接借鉴的原则：发布仓库独立；同一版两个 CPU 产物齐备；校验/签名先于发布；版本单调、渠道不能失败后偷换；安装失败保留可用版本；日志能解释重启失败。

Pi Hub 使用成熟 Electron 安装框架，不复制 Magpie 的自研 app 交换脚本。首版信任链与 Magpie 不完全相同，见第 7 节，不能把 SHA-512 metadata 称为 Ed25519 已签名的发布清单。

## 3. 用户界面与交互

在既有独立「Pi Hub 设置」窗口增加第四个类目「应用更新」，使用已确认的 Clear Order 字体、颜色、间距、固定导航与底部操作区。原有终端/会话存储/Pi 启动类别及设置草稿规则保留。

更新页显示：当前版本、当前 CPU、更新渠道、自动检查开关、最近检查时间、候选版本与更新说明。新增应用菜单「检查更新…」；手动检查激活这个页面，重复点击复用窗口和同一检查请求。

| 状态 | 展示与操作 |
|---|---|
| 初始 / 已是最新 | 「检查更新」；无打断式成功弹窗 |
| 检查中 | 页内进度状态，禁止并发检查；主界面仍可使用 |
| 发现新版 | 版本/日期/说明，按钮「下载更新」与官方 Release 链接 |
| 下载中 | 文件大小与进度，支持取消；关闭窗口不等同取消后台下载 |
| 下载完成 | 「重启并安装」；明确说明最终签名与安装准备在安装时完成 |
| 安装准备中 | 先退出守卫，再短时冻结新的写操作；主进程完成原生准备与签名检查 |
| 检查/下载/验证失败 | 就地解释并可重试；当前应用与会话继续可用 |
| 手动更新模式 | 说明当前运行条件不支持应用内安装，提供对应架构官方包 |

后台发现新版只给低干扰提示，不抢焦点；用户关闭提示后不在每次轮询重复弹出。发布说明按纯文本或清洗后的有限 Markdown 展示，不能执行发布者正文中的 HTML/脚本；外链仅通过受控主进程打开。

更新偏好即时保存，渠道变更时取消/失效旧候选和旧下载请求，避免「界面显示稳定版，实际安装上一条预览请求」。下载缓存可以保留以节省流量，但安装前必须重新校对其版本、渠道与 hash。

## 4. 渠道与版本规则

| 渠道 | 版本与发布方式 | 允许到达的版本 |
|---|---|---|
| 稳定版（默认） | `x.y.z`，GitHub 正式 Release | 只接受高于当前版本的稳定版 |
| 预览版（自选） | `x.y.z-beta.n`，GitHub prerelease | 接受更高的 beta 或稳定版，不自动切 alpha/nightly |

切回稳定版不降级：若已安装 beta 新于当前稳定版，保持现有版本，显示等待后续稳定版；不自动恢复旧数据库。每次设置 updater.channel 后都必须重新设 allowDowngrade=false，再独立执行版本与渠道判断。

预览用户也能接收之后发布的更高稳定版。稳定发布可提供内容相同的 beta-mac.yml metadata 别名，使该规则显式成立；缺少 beta metadata 不是随意选择别的渠道的授权。正式 Release 的 Latest 指针只向最高合格稳定版移动，旧版本重跑不能覆盖；beta 不占据 stable Latest。

版本统一来自 package.json/tag，客户端、ZIP、app Info.plist、metadata 一致。更新器依赖在实施时重新核对正式 npm 版本并锁定；本次研究的正式版是 6.8.11，不使用尚未发布的 master 7.x API。

## 5. 发布仓库与 CI

仓库职责：源代码仓库保存产品代码与普通 CI；单独的公开 pi-hub-releases 仓库保存发布工作流、Release 和资产。实际 owner/name 待用户指定，不会擅自创建或发布。

发布流水线：

1. 用户批准的版本 tag 解析为固定 source commit SHA；发布工作流只接受被允许的源仓库/受保护分支上的已批准提交。
2. 分别构建 x64 与 arm64，沿用现有 Node24+/Pi 最新版本测试与测试隔离。现有 npm run package / package:x64 / package:arm64 的本地构建仍可使用。
3. 在最终签名之前生成 Contents/Resources/app-update.yml，固定发布仓库与 updaterCacheDirName。签名之后禁止再向 app 包写配置。
4. Developer ID 签名、hardened runtime、公证并 stapling；验证最终 app、Electron Helper、SQLite 与 Pi 原生依赖架构/签名。
5. 制作每个 CPU 的 ZIP（应用内升级使用）与 DMG（首次/手动安装使用）。即使有 DMG，ZIP 仍不可省略。
6. 合并两 CPU 产物后生成更新 metadata：latest-mac.yml 或 beta-mac.yml，包含精确 URL、大小、SHA-512、版本和发布时间；发布独立 SHA256SUMS 与 provenance 供人工/审计使用。metadata 的 hash 必须来自最终 ZIP。
7. 上传一个 draft Release，核验两 CPU 的四个分发文件、metadata 与校验文件全部可读；完成才公开。任何一架构失败都不发布不完整版本。
8. 重新读取并核对 Latest/渠道与版本；保存 source SHA、依赖锁、构建产物与发布记录。Release 发布后不替换同版本二进制，修复用新版本。

Secrets 仅进入受保护发布 job，普通 PR/fork 不获得发布凭据。独立发布仓库减少普通开发工作流接触 Secrets 的机会，但执行任意不可信源代码仍能泄露 Secrets，因此固定 SHA 与发布审批同样必要。客户端不放发布 Token、签名私钥或公证凭据。

## 6. 安装、数据和会话生命周期

### 安装协调

不直接把设置页按钮绑定到 quitAndInstall。

1. 复用统一退出协调器；有终端/Pi 配置草稿时先继续编辑或放弃，当前设置操作/导入未完成时等待用户完成或取消。用户取消则什么都不安装。
2. 守卫通过后短时禁止新的配置/项目/会话写操作，保留只读展示；已发出的重命名、Clone、删除等先获得确定结果或保留可核对回执。进入安装准备前确保后台不再执行未完成写入。
3. JS 缓存下载完成不代表原生签名已验证。使用已配置的公开原生 autoUpdater 检查接口先完成 Squirrel 暂存与签名验证；本阶段不调用会立即退出的 MacUpdater.quitAndInstall。
4. 原生验证失败：解冻界面，现有后台保持运行；保留错误与可重试状态。不得提前把 BackgroundSessionManagement.close() 调用成不可恢复的 stopping 状态。
5. 原生验证成功后，记录安装提交状态，正常关闭单一 SQLite 后台、断开宿主控制连接，再最终调用已就绪的 quitAndInstall。before-quit-for-update 只同步识别已批准状态，不依赖它等待异步保存。
6. 此后原生替换由 Squirrel 执行。若最终退出失败仍留在当前应用，要可重建后台、核对待安装状态；不能留下界面开着但所有服务永久「正在退出」的半关闭状态。已经交给原生的更新也不能再声称普通退出绝不会安装它。
7. 新版本启动后比较实际 app 版本与目标，核对数据打开及宿主重连，再显示一次「已更新」；不在下载或退出之前报告升级成功。

研究已确认这条公开 API 分阶段路线的源码条件，但没有执行真实升级；必须在实施初期以两份隔离签名 app 做真实验证，之后才接正式产品交付。测试不得用假的下载/安装成功回执代替原生升级。

### 用户数据与外部 Pi

- 默认数据根继续为 ~/.pi-hub。更新偏好、受限日志与 JS 下载缓存放在这个根下的 updates/；系统/Squirrel 安装暂存遵循框架行为，不承诺重定向所有系统文件。
- 更新只替换 Pi Hub app。不安装/升级用户的 Pi CLI、Node、全局扩展，不改原始会话 JSONL、ID、目录和用户配置。
- Hub 退出仅断开控制。已有 Terminal/Ghostty 中的 Pi 保持运行，新 Hub 使用持久身份和协议重新接入；每次发布要求新 GUI 兼容上一发布的运行中宿主，协议不兼容时必须单独制定迁移策略，不能偷偷结束宿主。
- SQLite 继续在 schema 迁移前备份，并拒绝不支持的新 schema；安装失败恢复旧 app 与业务数据回滚是两回事。出现启动/迁移失败保留数据和备份，不自动用旧数据库覆盖之后产生的真实记录。

### 首版运行限制

- 正常签名、已安装到可更新 app 目录的默认资料库实例支持应用内更新。开发模式、未签名包、只读 DMG/转移隔离路径或权限不满足时给手动包，不静默提权。
- 显式 --user-data-dir 首版只支持检查及官方手动包路径，不做应用内替换/自动重启。Squirrel 默认重启不保留 argv，不能接受更新后打开错误资料库的风险；该模式日后单独扩展并验证。用户需以相同参数重新打开手动更新后的 app。
- 当前执行环境为 Intel；实施时需验证 Intel 原生 A→B，Apple Silicon 的原生 arm64 及 Rosetta→arm64 更新需要对应机器验收。静态交叉构建不能冒充 ARM 实机升级成功。

## 7. 安全、故障与恢复

首版固定 HTTPS GitHub 仓库；不允许 UI 输入任意 Feed/脚本，不内嵌 GitHub Token。更新相关 IPC 只允许精确可信主窗口/设置窗口，参数只接受枚举的渠道和操作，不接受 renderer 提供下载路径、执行命令或签名豁免。

采用 HTTPS、metadata SHA-512 和 macOS 对现有签名身份的验证。后者是应用真实性依据；发布说明/metadata 本身首版不具备 Magpie 的独立 Ed25519 签名。不能把来自同一服务器的 hash 当成独立真实性证明。

无网络、限流、404、磁盘不足、hash 不符、错误签名、版本/CPU 不符时，不覆盖现有 app，不标记成功；保留原渠道。缓存文件采用临时完成标记与原子发布，取消/失败残留可清理；不承诺跨所有网络错误断点续传。日志只记录版本、阶段、错误码和安全化路径，不记录会话正文、凭据、授权头。

Squirrel 有替换过程中恢复旧包的机制，但没有 Pi Hub 数据库健康回滚保证。坏版本应撤下后续推荐并发布修复版本；已经升级的用户不自动降级。人工恢复旧 app 前必须核对 schema 兼容性和备份。

若后续需要官方 CDN/镜像与更强的 metadata 信任，在启用多来源之前增加独立签名 manifest，覆盖渠道/版本/平台/CPU/hash/URL，并把公钥固定进 app；不能仅增加一个可改 URL 的镜像选项。届时再评估已正式发布的更新器原生签名机制，不基于本次看到的未发布 master 功能作保证。

## 8. 实施顺序与验收

A. 发布基础：确定仓库、Developer ID、公证与权限；先生成两份签名验证用 A/B，验证 Forge 配置位置、ZIP/metadata、原生阶段与退出顺序、签名失败后服务可继续使用。A/B 只改变受控版本，不调用付费模型。

B. 客户端：主进程单例更新服务、状态/日志/缓存、设置页和应用菜单、明确渠道策略、可恢复退出协调器。

C. 自动化与原生验证：

| 范围 | 必须证明 |
|---|---|
| 策略/网络 | 稳定排除 beta；预览可接稳定；切回稳定不降级；旧发布重跑；限流/离线不改渠道；版本/metadata 不一致拒绝 |
| 文件/信任 | 两 CPU、完整 ZIP/metadata；错误 hash、错误签名、错误 CPU、磁盘不足失败；校验失败保持当前版本 |
| 设置/退出 | 保存/放弃/取消；导入进行中；下载可取消；普通退出不应用仅缓存的下载；安装前后台活着，验证失败仍可读写；安装提交后后台正常关闭 |
| 真实 A→B | 真正重启为 B、数据未改、旧宿主 PID/start/TTY 不变、Terminal/Ghostty 未关闭、B 重新连接；原始 JSONL byte hash 保持 |
| Profile | 显式自定义资料库禁用自动安装且不触碰默认根；只读/开发/未签名包提供手动路径 |
| CPU | Intel 原生升级；ARM 原生升级；Rosetta→ARM；不具备硬件时保留明确未验收项 |
| 交付 | 首个手动引导版签名、公证、GitHub 发布完整性；正式渠道从 A 到 B 的端到端检查；无法完成发布条件时不宣称应用内更新已交付 |

D. 用户批准首个正式发布后发布引导版；当前用户手动替换一次，后续升级使用应用内流程。批准实施不等于授权自动公开仓库、上传证书或发布 Release，涉及外部创建/发布仍按明确授权执行。

## 9. 实施前待落实

| 项目 | 当前状态与要求 |
| --- | --- |
| 开始实施 | 用户已要求暂缓；本方案固化不授权添加依赖、功能代码或发布工作流。 |
| 仓库归属 | 本机项目尚无 Git remote；需指定源码与公开发布仓库的账号/组织及名称，不能擅自创建。 |
| 签名与公证 | 本机 Pi Hub 未签名；是否具备 Apple Developer Program、Developer ID Application 与公证条件尚未确认。凭据由安全配置提供，不写入文档或聊天。 |
| 更新器正式版本 | 研究核对的是正式 npm 6.8.11；实施时重新核对正式版本、锁定依赖并重验关键行为，不能照搬未发布 7.x API。 |
| 真实升级原型 | 先验证隔离签名 A→B、分阶段原生准备与退出协调、错误签名后服务恢复，再允许接正式发布。源码分析不替代验收。 |
| ARM 硬件 | 需要 Apple Silicon 原生及 Rosetta→arm64 升级实测；当前没有该结果。 |
| 对外操作 | 建仓、凭据配置、发布 Release 与首个引导版安装，均需对应授权；没有自动公开或发布的隐含许可。 |

条件不齐备时继续使用当前手动构建/替换方式，见[本机应用](local-app.md)。手动 Release 分发是可单独授权的后续范围，不因方案固化自动开始。

## 10. 研究依据与已知边界

研究日期为 2026-11-17，来源使用固定版本或提交；实时渠道的数字只是当时快照。

| 已核实事项 | 证据与含义 |
| --- | --- |
| Magpie 自研更新器与独立发布 | 主仓库提交 `acc358f071bf64730eadc1704956f8686a9d7359`；发布仓库提交 `802dc489b76868a5beb9cfd1164742f08561bb8b`。不是 Sparkle 集成。 |
| 三个渠道与清单签名 | Every 0.1.4341、Daily 0.1.4338、Stable 0.1.3960；实际使用内置公钥验证三份 Feed 的 Ed25519 签名，每份 15 个声明下载项的 hash 与签名清单相符。修改版本或清单后验证失败。没有下载全部二进制。 |
| 本机 Magpie | 0.1.4341 Intel，Developer ID 签名，签名验证通过且带 stapled 公证票据；没有执行其真实更新或读取账户配置。 |
| 本机 Pi Hub | 未签名且无更新器；现有双架构包不能直接用作完整更新发布资产。 |
| Electron 退出顺序 | 45.2.3 文档明确 quitAndInstall 可能先关闭窗口，常规 before-quit 不足以保护草稿；必须主动协调。 |
| 正式更新器默认值 | 6.8.11 默认自动下载、普通退出时安装；channel setter 会允许降级。必须显式覆盖并测试。 |
| Forge 配置与缓存 | app-update.yml 在签名前放进 Resources；仅 setFeedURL 不能替代该文件。AppAdapter 可控制 JS 下载缓存，不能承诺控制系统原生暂存。 |
| 自定义 profile 重启 | 该 Electron 绑定的 Squirrel ShipIt request 没有启动 argv，NSWorkspace 以空配置重启；首版自定义 profile 采用手动更新。 |
| 宿主独立性 | 当前自动/手动启动均把 SDK 宿主脚本复制到 profile，运行中的 Node/Pi SDK 独立于 app；保留运行实例的真实 A→B 兼容性仍需实施验收。 |

一手来源：

- [Magpie 源码与发布触发](https://github.com/yetone/magpie/blob/acc358f071bf64730eadc1704956f8686a9d7359/.github/workflows/release.yml)、[发布工作流](https://github.com/yetone/magpie-releases/blob/802dc489b76868a5beb9cfd1164742f08561bb8b/.github/workflows/release.yml)。
- [Magpie 更新器](https://github.com/yetone/magpie/blob/acc358f071bf64730eadc1704956f8686a9d7359/internal/update/update.go)、[清单签名验证](https://github.com/yetone/magpie/blob/acc358f071bf64730eadc1704956f8686a9d7359/internal/update/signed.go)、[渠道规则](https://github.com/yetone/magpie/blob/acc358f071bf64730eadc1704956f8686a9d7359/site/worker.js)、[配置说明](https://github.com/yetone/magpie/blob/acc358f071bf64730eadc1704956f8686a9d7359/docs/reference.md)。
- [Electron 45.2.3 autoUpdater](https://github.com/electron/electron/blob/v45.2.3/docs/api/auto-updater.md)、[Forge 自动更新指导](https://www.electronforge.io/advanced/auto-update)、[electron-updater 6.8.11 正式包](https://www.npmjs.com/package/electron-updater/v/6.8.11)。
- [本项目 Electron 绑定的 Squirrel 源码](https://github.com/Squirrel/Squirrel.Mac/tree/fffea30e4a339a7f7d69a3391314b72548d209bd)，包括 SQRLUpdater、SQRLInstaller、SQRLShipItRequest 和 ShipIt-main。

研究原始公开源码、fetch 回执、Feed、签名探针和本机签名结果仅在执行机器被忽略的 `.scratch/pi-hub-update-channel/evidence/` 保留，不随仓库分发，也不是第二套规格。没有运行 Magpie 更新、签名 Pi Hub A→B、应用替换或远程发布；本次只有研究与文档固化，不构成更新功能认证。以后实施应先核对最新正式依赖及公开 API，并按第 8 节补齐证据。
