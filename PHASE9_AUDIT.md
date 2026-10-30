# 第九阶段安全边界审计

审计日期：2026-10-29

基线：第八阶段已完成本地 MVP 验收。本阶段审计前重新运行 typecheck 与全量测试，确认代码与验收记录一致；未升级或修改 DeepSeek Harness 核心。

## 1. 范围与结论

范围：

- Agent 输入路径与工具白名单
- 工作区、HAR、Java/WAR、报告与 artifact 路径
- 符号链接、路径穿越、不存在路径
- API 目标、重定向、DNS 解析与内网地址
- 凭据、模型输入、日志、报告与临时文件

结论：发现并修复 4 个 P0/P1 级缺口；未发现任意 shell 执行通道。当前仍有一个 DNS 校验与实际 fetch 解析之间的时间差风险，已列为 P1 残余风险。

## 2. 已修复问题

### P0-1 Agent 可读取任意本地路径

原问题：

- `src/agent/tools.ts` 的 `resolvePath()` 只做 `resolve()`。
- `har.inspect`、`api.replay`、脚本生成、性能执行和 `code.analyze.java` 均可读取计划中的任意绝对路径。

修复：

- `ToolExecutionContext` 增加 `workingDirectory` 与 `allowedInputRoots`。
- Orchestrator 默认只授权工作区；额外输入根必须显式传入。
- 所有 Agent path 工具统一用 `resolveInside()` 做词法与 canonical 校验。
- 桌面端 Java/WAR 分析输入在用户选择时写入 `.test-agent/code-inputs/<task_id>.json` 授权记录；执行时计划路径必须与该记录一致。
- 插件/CLI 默认仅工作区授权。

验证：

- `tests/integration/agent-code-analysis.spec.ts`：授权 Java 根可执行，未授权路径失败并记录 `outside authorized input roots`。

### P0-2 公网域名可解析到本机或内网地址

原问题：

- 只校验 URL origin 字符串，不检查 DNS 解析结果。
- 公网域名若被解析到 loopback/private/link-local/ULA 地址，存在 DNS rebinding/SSRF 风险。

修复：

- 新增 `assertTargetNetworkAllowed()`。
- API replay 和凭据连接测试在请求前解析目标主机。
- 显式 IP、`localhost`、`.local`、`.internal` 目标仍需用户授权，可访问。
- 公网域名解析到敏感地址时拒绝。
- HTTP redirect 保持 `manual`，跨 origin redirect 必须命中白名单，否则 blocked。

验证：

- `tests/unit/target-policy.spec.ts`。

### P1-1 凭据无法安全注入

原问题：

- 资产中只有 opaque credential refs，API replay 不解析。
- 项目配置禁止敏感 header，导致需要认证的真实 API 无法测试。

修复：

- 新增 `src/desktop/credential-service.ts`。
- 支持 Bearer、Cookie、Basic Auth、自定义 Header。
- 项目配置只保存 `safe://<id>` 引用。
- 秘密值仅通过 Electron `safeStorage` 加密存储在应用 userData，不在项目、资产、日志、报告或 Renderer 中出现。
- API replay 在主进程运行时按引用解析并注入请求头。
- 401/403 记录为 `auth` 失败，凭据缺失/解密失败给出明确错误。
- UI 提供保存、选择、测试、删除；不回显完整秘密。

验证：

- `tests/desktop/credential-service.spec.ts`
- `tests/integration/phase9-api-correlation.spec.ts`

### P1-2 API replay 缺少运行时数据关联

原问题：

- correlations 仅用于 k6/JMeter 生成器，API replay 不提取、不替换。

修复：

- API replay 支持 `sourceIndex -> JSONPath -> variableName`。
- 后续 path/body 可使用 `${variableName}`。
- `targetHeaders` 可把变量注入指定 Header，支持模板如 `Bearer ${accessToken}`。
- 有 correlation 时强制顺序执行；变量只在本次 replay 内部存在。
- 并发 replay 之间不共享状态。
- 提取失败、前置失败、目标变量缺失记录为 `correlation` 失败。
- 报告新增 `correlation_results`，只保存变量名、来源/目标请求和状态，不保存变量值。

验证：

- `tests/integration/phase9-api-correlation.spec.ts`
  - 登录 -> 注入 Bearer Token -> 创建订单 -> 提取 ID -> 查询订单
  - 安全 tenant credential 注入
  - 并发 replay 变量隔离
  - 提取失败与缺失变量错误

### P1-3 崩溃临时文件治理缺失

原问题：

- 原子写崩溃后 `.tmp` 可能残留在 `.test-agent`。

修复：

- 新增 `cleanupStaleTemporaryFiles()`。
- 打开项目时清理 `.test-agent` 内超过 5 分钟且匹配原子写命名规则的 `.json/.state` 临时文件。
- 不删除用户输入文件、普通 `.tmp`、报告或任务状态。
- 报告写入失败时保留任务失败状态和诊断。

验证：

- `tests/desktop/temp-cleanup.spec.ts`

## 3. 保留风险

### P1 DNS 校验时间差

当前实现先做 DNS 安全检查，再交给 Node fetch。若恶意服务在检查后快速切换 DNS 记录，仍存在时间差。已采取缓解：

- 重定向手动处理且白名单校验。
- 公网域名解析到敏感地址会失败关闭。

后续可在自定义 fetch agent 中 pin 解析地址，或在真实业务接入时使用固定测试环境 IP/内网域名。

### P1 Token 生命周期

当前支持运行时提取 token 并注入后续请求，但无自动刷新、轮换和过期时间解析。401/403 会明确失败。

### P1 桌面文件选择人工流程

文件选择对话框本身仍缺少完整 GUI 自动化测试；主进程服务路径校验和授权记录已测试。

### P2 WAR 嵌套 JAR / Java parser 限制

延续第八阶段结论，不因本阶段安全加固而改变。

## 4. 安全边界现状

- Agent 工具无 shell，仅固定白名单。
- Agent 输入默认限制在工作区，桌面 Java/WAR 输入需要持久授权记录。
- 项目路径、报告路径、artifact 路径使用 `resolveInside()`。
- 符号链接通过最近存在父级 canonical 校验阻止逃逸。
- 不存在路径会回溯到最近存在父级再校验。
- API base URL 拒绝 credential/query/fragment。
- allowed origins 必须包含 target origin。
- redirect 手动处理且跨 origin 拒绝。
- HAR 输入、响应预览、断言输出、UI 输入和模型 goal/scope 均脱敏。
- Credential 和模型密钥使用 macOS 安全存储；安全存储不可用时拒绝保存。
- 取消/超时不会标记为 passed。
