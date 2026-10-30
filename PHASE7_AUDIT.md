# 第七阶段实施审计

审计日期：2026-10-28

范围：第五/六阶段验收材料、CLI、Electron 主进程/Renderer、Agent 编排、API/UI/性能执行器、资产管理、Java/WAR 分析、覆盖分析和报告持久化。以下结论来自当前源码和测试，不把文档声明当作已验证事实。

## 1. 调用关系复核

```text
CLI src/cli/bin.ts
  ├─ har/parser -> api/replay -> results/result
  ├─ generators/k6|jmeter -> engines/executor -> engines/report
  ├─ ui/validation -> ui/runner
  ├─ code/java-analyzer
  ├─ desktop project/task services -> assets/coverage services
  └─ agent planner/plan -> orchestrator -> allowlisted tools

Desktop renderer (sandbox, no Node)
  -> preload typed IPC
  -> DesktopAppService
     ├─ ProjectService: project.json / sanitized HAR / config / recents
     ├─ TaskService: API, UI, k6/JMeter, task state, logs, reports
     ├─ AssetService: native HAR/UI/k6/JMX assets + run history
     ├─ CodeAnalysisService / CoverageService
     └─ AgentService: deterministic plan + confirmation + orchestrator
```

一致性结论：

- CLI 与桌面端复用同一批核心模块，未发现重复实现 replay、generator、engine、report、Java 分析或 UI runner。
- Renderer 未直接解析 HAR、执行测试或计算指标，符合第五阶段架构约束。
- Harness checkout 仍为 `1f81c047fc48fa190a683e469daa699857e9afe8` / `dsh-v0.2.1-rc.3`，核心源码未修改。
- 测试中的 fake executable/mock catalog 只用于错误路径和编排单元测试；第六阶段交付证据另含真实 UI/API/k6/JMeter 结果，未发现用 mock 冒充真实验收。

## 2. P0 问题

### P0-1 API 报告可泄露响应体或断言中的敏感值（已修复）

- 证据：`src/api/replay.ts:169` 将原始响应前 200 字节写入 `responsePreview`；`src/api/assertions.ts:57-79` 将 expected/actual/body preview 写入断言结果；`src/results/result.ts:44-53` 原样持久化这些字段。
- 影响：若服务端响应包含 `token`、`api_key`、`password` 或 Authorization 形态的值，会进入普通 JSON 报告、任务 artifact、资产历史和模型分析上下文。
- 修复：在 replay/assertion 边界复用统一脱敏函数，对响应预览、断言 expected/actual/error 做输出脱敏；新增真实响应 fixture 测试，确认报告和状态记录不泄露。
- 状态：已修复。`tests/unit/report-redaction.spec.ts` 通过；报告 response preview、断言 expected/actual/error 均脱敏。

### P0-2 桌面端没有模型网关配置，模型状态被硬编码为不可用（已修复；外部商用模型未验证）

- 证据：`src/desktop/types.ts:154-165` 将 `AgentPlanPreview.modelStatus` 限制为 `'unavailable'`；`src/desktop/agent-service.ts:23,44-64,87-94` 始终生成 deterministic plan 并返回固定不可用文案；`desktop/preload.ts` 和 `desktop/main.ts` 无模型配置 IPC。
- 影响：无法满足第七阶段模型可用/不可用双路径验收，也无法从桌面配置 Provider、模型、Base URL 或密钥。
- 修复：新增主进程模型配置服务，支持 macOS Electron `safeStorage` 加密存储密钥；配置文件不保存明文密钥，Renderer 只收 masked 状态。接入 OpenAI-compatible chat completions 网关，模型输出仅作为 JSON 文本进入既有 `generatePlanWithModel` schema 校验和工具白名单，执行仍需人工确认。不可用/超时/限流/非法 JSON 均降级为 deterministic 并保留安全错误信息。
- 状态：已修复。`tests/desktop/model-service.spec.ts`、`tests/desktop/agent-model.spec.ts`、沙箱外 `tests/integration/phase7-model-gateway.spec.ts` 通过；外部商用 Provider 因本机未配置真实密钥标记未验证。

### P0-3 缺少第七阶段要求的单一端到端闭环集成测试（已修复）

- 证据：现有测试分散：`tests/integration/coverage-execution.spec.ts` 覆盖 Java 分析->候选->API 执行；`tests/integration/agent-orchestrator.spec.ts` 使用 fake catalog 测编排；`tests/integration/ui-runner.spec.ts` 测 UI；`tests/integration/engines.spec.ts` 测引擎错误/超时。没有单一场景同时验证导入、代码分析、计划、确认、真实执行、证据关联、报告和历史差异。
- 影响：无法证明所有模块在真实项目工作区中可连续运行，也无法防止某一模块后续破坏端到端链路。
- 修复：新增本地 fixture 集成测试，使用同一 Project/Task/Asset/Coverage/Agent 服务，完成 HAR 导入、Java 分析、结构化计划校验、未确认拒绝执行、确认后真实 API 执行、任务/报告/资产/代码分析关联、重复运行和历史比较；覆盖率无 runtime 输入保持 `null`。
- 状态：已修复。沙箱外 `tests/integration/phase7-end-to-end.spec.ts` 通过并生成 `evidence/phase7/e2e/evidence-summary.json`。

### P0-5 桌面 API replay 取消/超时会落成 test_failed 而非 cancelled/timeout（已修复）

- 证据：`src/desktop/task-service.ts` 原 `executeReplay()` 仅按 `report.failed` 写 `test_failed`；`replayHar()` 在请求级 abort/timeout 时通常返回包含 `errorKind: cancelled/timeout` 的结果而不是抛出异常。
- 影响：任务历史不能准确反映用户取消或请求超时，可能干扰失败分析和重复执行策略。
- 修复：根据外部 abort 与请求结果 `errorKind` 归类为 `cancelled` / `timeout`，并新增真实本地回环生命周期测试。
- 状态：已修复。沙箱外 `tests/integration/task-lifecycle.spec.ts` 验证 cancelled 与 timeout。

### P0-4 打包 App smoke 未验证 Playwright/浏览器调用（已修复）

- 证据：`desktop/main.ts:44-52` 仅通过 Renderer 调用 `bootstrap()`；第六阶段文档中的“打包后的 App 可以调用 Playwright”只能由源码依赖和开发环境测试推断，未在打包产物内启动浏览器。
- 影响：不能排除 app.asar 依赖解析、Chromium 发现、macOS 沙箱或权限导致打包 UI 执行失败。
- 修复：增加可选 `--smoke-ui` 深度验收：在应用 userData 下创建临时项目，注入本地 HTML/授权配置和 UI 用例，由打包 App 主进程真实调用 Playwright，输出 run id/状态，并清理临时项目。保留 `--smoke-test` 为快速启动检查。
- 状态：已修复。开发版与打包 App `--smoke-ui` 均真实调用 Playwright/Chrome；打包 App run `ui_20261028032008_f8f906` 为 2/2 passed。

## 3. P1 问题

### P1-1 Agent 输入路径缺少工作区根约束

- 证据：`src/agent/tools.ts:368-372` 对普通 path 工具仅做 `resolve()`；`src/agent/plan.ts:316-331` 只校验非空路径和参数白名单。只有 `report.read` 在 `assertReadablePath()` 中限制 output/artifact 目录。
- 影响：已确认计划仍可让无副作用工具读取计划指定任意本地 HAR/Java 输入。对桌面端，HAR 已限制在项目内，但 Java 路径来自文件选择器，Renderer 被攻破时可通过 IPC 提交任意路径。
- 修复方案：为 Tool Catalog 增加 allowed input roots；桌面 AgentService 传入 project root 与用户显式选择的 Java 根；CLI/插件按参数显式授权。计划展示绝对路径，确认后才可读。
- 状态：待评估，第七阶段先记录风险，不阻塞本地 fixture 闭环。

### P1-2 崩溃后原子写临时文件缺少恢复清理

- 证据：`src/agent/state.ts:76-83`、`src/desktop/task-service.ts:551-557`、`src/assets/service.ts` 均使用临时文件 + rename；崩溃或进程被杀后可能残留 `.tmp`。
- 影响：不破坏最终状态读取，但会留下可审计性噪音，且项目移动/打包时可能携带部分敏感内容。
- 修复方案：服务启动/项目打开时按精确前缀清理当前主机且过期的临时文件；不删除其他进程正在写的文件。
- 状态：待后续处理。

### P1-3 模型分析增强没有桌面执行路径（已修复）

- 证据：Harness 插件 `src/plugin/agent-tools.ts:406-431` 已复用 `ctx.llm.stream`，但桌面 AgentService 只调用 deterministic orchestrator analyze。
- 影响：即使模型计划生成接入，失败分析仍不能在桌面使用模型增强。
- 修复方案：模型配置完成后给 `enrichAnalysisWithModel` 提供同一受控文本客户端，并把模型状态写入 `failure_analysis`。
- 状态：已修复。AgentService.analyze() 复用 enrichAnalysisWithModel；`tests/desktop/agent-model.spec.ts` 验证模型增强与确定性事实保留。

### P1-4 WAR 嵌套 JAR 未内省

- 证据：`src/code/java-analyzer.ts:200-207` 仅统计 nested JAR 并标记 missing-dependency。
- 影响：依赖内部调用链 unresolved，不能证明完整业务调用图。
- 修复方案：后续以受内存/条数限制的嵌套 ZIP 清单和 class 引用解析为主，不执行代码，不宣称源码还原。
- 状态：已知限制，不伪装成已分析。

### P1-5 Java 源码解析器不完整

- 证据：`src/code/java-analyzer.ts` 使用正式/有限状态掩码 + 正则，不支持完整 Java 语法树；每个文件仅取第一个 class 声明；泛型/Lombok/注解处理器输出可能缺失。
- 影响：真实大型项目会产生漏报或 uncertainty，不适合作为完整编译器替代。
- 修复方案：真实试点时记录 parser coverage 和 unsupported-syntax 数量；若 P0 业务样本无法解析，引入 Java parser 或 javac AST/API 做最小增强。
- 状态：已知限制。

## 4. P2 问题

### P2-1 桌面手工 UI 交互缺少自动化浏览器级测试

- Renderer 事件绑定和视图存在，Electron smoke 只验证 bootstrap。文件选择对话框需要人工操作。后续可用 Playwright Electron API 和预置工作区覆盖导航、配置、启动/取消。

### P2-2 打包产物未签名/未公证

- `desktop/electron-builder.mjs` 设置 `identity: null`。发布前需要 Developer ID Application 证书、 hardened runtime、entitlements、notarytool 凭据和 Team ID；当前只能作为本机开发构建。

### P2-3 远程服务端仍未建设

- 第六阶段结论继续有效：当前无多人协作/集中调度需求，仅保留服务边界，不实现 Web 服务端。

## 5. 任务生命周期与安全复核

已实际验证或已有自动化覆盖：

- 重复执行保护：Agent task 已成功后拒绝再次执行；桌面 ProjectRunGate 阻止同项目并发任务。
- 取消：Agent、API replay、k6/JMeter、UI 均接 AbortSignal；第七阶段新增 API replay 终态测试。
- 超时：API fetch timeout、engine timeout、UI step timeout、模型请求 timeout 均有实现；API/引擎/模型路径有测试。
- 异常退出恢复：桌面任务从 queued/running 恢复为 interrupted；Agent lock 按 PID/host/时效处理。
- 报告持久化：API/UI/engine 报告写项目 `output/`，任务记录保存 report/log/run id。
- 路径安全：`resolveInside()` 已做词法边界和最近存在父级 canonical 校验，测试覆盖 symlink escape。
- 凭据输入侧：HAR parser 脱敏敏感 header/query/body；项目配置拒绝敏感 header 和 URL credential；UI 输入值报告脱敏。

第七阶段补强完成：响应/断言输出侧脱敏、模型配置存储、API 取消/超时终态、端到端闭环和打包 UI 深度 smoke 均有自动化验证。

## 6. 修复顺序（已执行）

1. P0-1 输出脱敏和回归测试。
2. P0-2 模型配置、安全存储、schema 校验、可用/不可用测试与桌面配置 UI/IPC。
3. P0-3 端到端闭环集成测试。
4. P0-4 打包 App 深度 UI smoke 与发布验证。
5. 回访 P1-3；其余 P1/P2 按试点结果排期。
