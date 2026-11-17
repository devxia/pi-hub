# 本机应用

## 环境与构建

使用 Node 24+、npm 和 macOS 构建。依赖锁定的包内 Pi SDK 为 1.5.2；外部 Pi 与新测试统一使用官方最新版本，当前已核实为 1.5.2。版本升级先检查公开 API 和真实终端，不自动降级用户环境。

~~~sh
npm ci
npm run typecheck
npm test
npm run build
npm run package
~~~

`npm run package` 通过 Electron Forge 同时生成两份可离开仓库和开发服务器运行的 .app：

| Mac CPU | 命令 | 默认应用位置 |
| --- | --- | --- |
| Intel（x64） | `npm run package:x64` | `dist/packages/Pi Hub-darwin-x64/Pi Hub.app` |
| Apple Silicon（arm64） | `npm run package:arm64` | `dist/packages/Pi Hub-darwin-arm64/Pi Hub.app` |

使用与 Mac CPU 对应的包；这是两份独立架构的应用。`PI_HUB_PACKAGE_OUT` 可覆盖包输出根目录。`dist/desktop`、`dist/renderer`、`dist/terminal` 是编译中间文件；构建仅清理这三个目录，保留已生成的其他架构包。打包白名单排除 `dist/packages` 等非运行目录，防止将旧 .app 递归打入新包。整个 `dist/` 被 Git 忽略。

打包命令结束时自动检查本次架构包：ASAR 白名单、当前构建输入/运行资产、包内 Pi，以及 Electron/SQLite/Pi 原生模块的 CPU。构建回执 `dist/build-receipt.json` 不进入应用包；构建后源码或资产变化须重新构建。单独检查已有包可用 `npm run check:package -- --arch x64`，详见[测试规则](testing.md#包与安装)。双架构构建和静态检查不等于两类硬件都完成实机运行认证。开发使用 `npm start`，运行当前 Node/Electron 安装对应的架构；UI 检查参数与隔离规则见 [测试规则](testing.md)。

已安装位置为 `/Users/xiabinbin/Applications/Pi Hub.app`。当前使用手动替换，更新需先核对源码/包绑定、普通数据文件及精确进程身份，再正常退出 Hub、阶段复制并替换应用。不可在已有文件占用时直接覆盖；失败恢复上一应用。无需退出外部 Pi。

应用内更新的[渠道设计](update-channel.md)已固化并暂缓实施，当前没有“应用更新”设置或“检查更新”能力。规划中的稳定/预览渠道、签名引导版与更新安装验收尚未交付；具体发布仓库和签名条件仍待落实。

## 数据与项目

默认 Hub 数据根 `~/.pi-hub`，包含 SQLite、运行配置、宿主控制记录及 Electron 缓存/日志/Crashpad。可显式运行：

~~~sh
"/Users/xiabinbin/Applications/Pi Hub.app/Contents/MacOS/Pi Hub" --user-data-dir=/absolute/owned/profile
~~~

测试不能只设置 HOME；还须验证实际 userData、agent 和 sessions 都在自有目录。

原生会话默认读取 `~/.pi/agent/sessions`。额外来源在“设置 → 会话存储”选择编码目录/平铺枚举并完成历史选择。纳管或撤销来源不搬迁/删除原生数据。添加项目后选择全部、部分或零条进入主列表；其余归档。名称/项目/路径搜索与排序在当前范围生效。

## 打开与管理

Hub 自动发现 Pi/Node。双击会话或右键打开直接继续原记录；无默认终端时选择实际安装的 Terminal/Ghostty，可勾选保存默认。默认终端可在设置改选或清除。正常打开和定位不弹成功框；错误时按当前请求核对、重试或使用手动命令。

用户 shell 的交互登录导出供 SDK 宿主继承。已有宿主保留启动时环境，修改 shell 环境后应自行正常退出相关 Pi，再从 Hub 新开。Hub 不复制真实凭据到自身配置。

行右键菜单提供“复制并切换…”（原生 Clone 后同一终端切到副本）、重命名/清空、归档/恢复、完整 ID 复制、访达显示文件、可控实例退出和删除。主窗口关闭保留后台；Cmd+Q 退出 Hub 但外部 Pi 继续。退出会话只处理所选可控实例，忙碌时先确认。

原工作目录丢失时可选择可用纳管目录仅本次运行，或取消。原 header.cwd、ID、JSONL 和项目归属保持原值；下次仍需确认原目录。

## 设置与快捷操作

左下角“设置”、应用菜单“设置…”或 Cmd+, 打开独立单例窗口。终端、会话存储、Pi 启动各自保存；切换类目保留草稿。Cmd+W 关闭当前设置窗口，有未保存输入则确认。项目设置仍在项目上下文，一次性终端选择仍在打开流程。

Cmd/Ctrl+F 搜索，上下键移动条目焦点，Enter 预览，Shift+F10 打开当前行菜单；Option+上下键或拖动调整当前页展示顺序。重开后选择“手动排序”使用已保存顺序。窄窗预览 Esc 关闭并回原条目。

## 排障

- **读不到来源**：检查挂载、权限和来源路径，保留缓存并按来源恢复；不要把扫描失败当记录删除。
- **Pi 启动错误**：在 Pi 启动设置实际检测路径，编辑后重新检测，再保存。检测不修改其他用户资源或信任决定。
- **自动化权限失败**：由用户在 macOS 隐私与安全设置处理 AppleEvents；应用/测试不重置或代为批准。
- **主库不可读**：保留原库，查明确切错误并使用迁移备份恢复；不自动删库重建。
- **启动/操作结果未知**：核对原请求及原实例，不循环创建新请求。新一次明确打开会创建新实例。
- **界面首次读取较慢**：已有未能复现的启动/预览延迟记录，原因尚未证明；保持真实错误，不以重试通过推断根因已修复。详细证据见 [验证记录](validation.md)。

支持认证范围和产品限制见 [产品规格](product-spec.md#10-持久化安全与性能边界)。
