# Pi Hub

## 当前规则

用户最新明确决定优先。开始工作先读 [文档入口](docs/README.md)、[产品规格](docs/product-spec.md)和[GLOSSARY.md](GLOSSARY.md)，再读相关 ADR。界面使用 [DESIGN.md](DESIGN.md) 和正式变量/样板；集成使用 [Pi 事实](docs/pi-integration-facts.md)。

文档工作树只保留最终一致的规则。决定变化时更新完整正文及相关 ADR，删除被替代的决策/提案文件，不保留仅标记废弃的副本。完成任务的有效内容合并到现行文档；原始测试记录按版本引用，不能冒充当前契约或新验收。

## 开发约定（oil-dev）

- 快测：`npm run test:quick -- {target}`，例如 `tests/service/local-app-delivery.test.ts`。
- 重测：`npm run test:integration -- {target}`；静默 UI 用 `npm run test:ui -- {target}`；实际 .app 用 `npm run test:ui:foreground`，真实系统边界显式用 `npm run test:native`。
- 门禁：`npm run check`；交付前补 `npm test`，发布包用 `npm run package`（自动验包）；相关 UI/原生检查按[测试规则](docs/testing.md)选择。
- 高风险：`src/session-management/**`、`src/desktop/**`、`src/terminal/**`、`forge.config.cjs`。
- 执行频率：单模块先过滤快测；源码稳定后运行相关重测、构建一次；已通过且没有新变更/疑点时不重复全矩阵。

## 本地协作

- 规格和任务保存在已被 Git 忽略的本机 `.scratch/<feature-slug>/`，遵循[任务跟踪](docs/agents/issue-tracker.md)，不自动发布远程任务。
- 分类使用[标签映射](docs/agents/triage-labels.md)，实施进度单独记录。
- 领域词汇和 ADR 使用[领域约定](docs/agents/domain.md)。
- 测试遵守[隔离和执行规则](docs/testing.md)，交付依据[验证记录](docs/validation.md)。只执行与变更相称的检查，保留失败事实和版本边界。
- 未获指示不推送远程。原始测试证据不是可随意删除的临时文件；文档整理按用户范围明确处理。
