# ADR 0005：共享后台与窗口权限

Status: accepted

## 决定

一个 utility 进程持有 SessionManagement/SQLite，main 负责原生窗口、菜单、目录选择、剪贴板、访达及终端适配器。主 renderer 和设置 renderer 共用后台，不各开一套业务状态。

设置是独立非模态单例窗口：左下角“设置”、应用菜单“设置…”和 Cmd+, 指向同一入口；Cmd+W 关闭该窗口。终端/Pi 按类保存并保留跨类草稿；关闭/退出检查未保存与忙碌状态。来源历史选择及恢复留在设置窗口。一次性终端选择与项目设置保留原任务上下文。

两类 renderer 均启用 sandbox/contextIsolation，关闭 Node 集成和任意窗口/导航。可信 IPC 必须同时匹配登记 webContents、主 frame 和固定 file URL。设置只获得偏好、来源及 purpose=storage 的导入权限；项目选择、会话修改和终端控制仍限定主窗口。

## 理由与结果

非模态窗口支持一边管理来源一边查看工作区，单例避免配置草稿分叉；共享后台保持唯一写入者。固定 URL 不随类目切换变化，允许记住类目而不扩大信任面。preload 白名单限制能力，不能因为使用相同 HTML 就信任任意 renderer。

Hub 退出先处理设置草稿/进行中操作，再断开后台；取消保持应用和连接可用。主窗口关闭不终止后台跟踪或外部 Pi。
