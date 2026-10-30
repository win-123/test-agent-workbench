# 第七阶段真实验收证据

日期：2026-10-28。所有执行结果均来自本地 fixture、真实文件解析、真实 HTTP/Playwright/k6 或打包 App；未用模拟报告冒充真实执行。

## 1. 端到端闭环

入口：`e2e/evidence-summary.json`

- 项目：`e2e/phase-7-e2e`
- HAR：2 个真实 API 请求
- Java source analysis：`source_20261028031325_7add7e`
- Coverage analysis：`coverage_20261028031325_74cafd`
- API runs：`run_20261028031325_327893`、`run_20261028031325_e236c8`
- Candidate run：`run_20261028031325_27e3c1`
- UI run：`ui_20261028031325_6f0a67`
- k6 run：`engine_20261028031326_a38b31`
- Agent task：`agent_phase7_e2e`
- 未经确认的 Agent 执行在测试中被拒绝，tool call 记录保持 0；确认后执行 `har.inspect -> api.replay -> engine.run.k6`。
- 无 runtime coverage：`measured=false`，`percentage=null`。
- 历史比较保留两次真实 API run 的耗时差异。

报告与原始证据：`e2e/phase-7-e2e/output/`、`e2e/phase-7-e2e/.test-agent/`。

## 2. Java 源码与 WAR

- 源码：`code/java-source-analysis.json`
  - 4 classes、2 endpoints、5 branches、3 exceptions、3 uncertainties。
  - `OrderController.findOrder -> service.find` 记录 `arguments: ["id"]` 与 `parameter_evidence: source-text`。
- WAR：`code/java-war-analysis.json`
  - 安全清单 3 entries、1 class、1 nested JAR。
  - `DemoService.choose -> DemoService.helper` 记录 `parameter_types: ["java.lang.String"]` 与 `parameter_evidence: bytecode-descriptor`。
  - endpoint 为 0，不臆造 mapping；嵌套 JAR 明确 unresolved。

## 3. 模型网关

入口：`model-gateway/model-gateway-summary.json`

- 本地 OpenAI-compatible HTTP fixture：available。
- 模型生成计划通过 schema/工具白名单校验，plan hash `89cc308f61c59e75e76f0f8a5823660c39f3fdbfd1b45fb5da2d320aefa94787`。
- 未确认执行被拒绝。
- 非法 JSON 输出降级 deterministic，错误信息不包含密钥。
- 配置文件与证据不包含明文 API key。
- 外部商用模型未配置，未验证。

## 4. 桌面打包

入口：`desktop/package-smoke.txt`

- 打包 App bootstrap：passed，`TEST_AGENT_DESKTOP_SMOKE=ready`。
- macOS 安全存储：available。
- 打包 App 内真实 Playwright/Chrome：passed，run `ui_20261028032750_2bd5ba`，2/2 steps。
- App 未签名、未公证。
- 最终 ZIP SHA256：`22ecbf8daccceb52d7988a496d52b19ade4337eb24fd36934cfda089333b9a95`。

## 5. 任务生命周期

- `tests/integration/task-lifecycle.spec.ts` 在沙箱外通过。
- API replay 用户取消 -> `cancelled`。
- API replay 请求超时 -> `timeout`。
- 报告保留 `error_kind: timeout`，不把它伪装成业务断言失败。
