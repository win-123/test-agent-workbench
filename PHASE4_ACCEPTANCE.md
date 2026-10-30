# 第四阶段验收记录：Agent 测试编排

验收日期：2026-10-28

结论：第四阶段已完成并通过本地真实验收；按要求停止，未进入第五阶段。

## 1. 前置条件复核

- Harness checkout：`1f81c047fc48fa190a683e469daa699857e9afe8`
- Harness tag：`dsh-v0.2.1-rc.3`
- Harness 核心源码未修改；Git 中仅有本插件加载用的未跟踪 `scratch-plugin/`
- 修改前 `pnpm typecheck` 通过
- 修改前测试存在 2 个 k6 生成器失败，原因是生成脚本仍固化原始目标域名；已修复并实测
- API replay、JMeter、k6 均已在真实 fixture 上完成执行

## 2. 实际修改文件

### 编排核心

- `src/agent/types.ts`
- `src/agent/plan.ts`
- `src/agent/tools.ts`
- `src/agent/state.ts`
- `src/agent/orchestrator.ts`
- `src/agent/analyzer.ts`
- `src/agent/planner.ts`

### CLI 与 Harness 插件

- `src/cli/agent.ts`
- `src/cli/index.ts`
- `src/plugin/agent-tools.ts`
- `src/plugin/index.ts`

### 执行能力与测试

- `src/generators/k6.ts`
- `src/engines/types.ts`
- `src/engines/executor.ts`
- `src/engines/report.ts`
- `tests/unit/agent-plan.spec.ts`
- `tests/integration/agent-orchestrator.spec.ts`
- `tests/integration/agent-cli.spec.ts`

### 样例、文档与真实证据

- `samples/agent-plan.json`
- `README.md`
- `PHASE4_ACCEPTANCE.md`
- `evidence/phase4/k6/*`
- `evidence/phase4/jmeter/*`

## 3. 实际 Harness API

已核对并只使用以下真实能力：

- 工具注册：`ctx.tools.register(defineTool(...))`
- 当前 Agent：`ToolRunContext.agent`、`agent.options.provider/model`
- 模型调用：`ctx.llm.stream(...)`，请求路由来自当前 Agent，失败时降级
- 用户审批：`ctx.get('approval')?.request(...)`
- 工具执行参数与取消：`ToolRunContext.callId`、`exec.signal`

没有新增或臆造 Harness 核心 API。

## 4. CLI 使用

```sh
pnpm cli agent plan samples/demo.har \
  --base-url http://127.0.0.1:8089 \
  --goal "验证健康检查、回显与预期 500 失败" \
  --task-id phase4-demo-k6 \
  --engine k6 \
  --output samples/agent-plan.json

pnpm cli agent validate --plan samples/agent-plan.json
pnpm cli agent create --plan samples/agent-plan.json
pnpm cli agent execute phase4-demo-k6 --confirm <TOKEN>
pnpm cli agent status phase4-demo-k6
pnpm cli agent analyze phase4-demo-k6
pnpm cli agent cancel phase4-demo-k6
pnpm cli agent resume phase4-demo-k6 --retry-uncertain <STEP_ID>
```

CLI 计划生成是确定性的，明确返回：

```json
{
  "model_status": "unavailable",
  "model_error": "CLI plan generation is deterministic and does not load a Harness model; use the Harness plugin for model-driven planning."
}
```

## 5. 结构化计划示例

样例文件：`samples/agent-plan.json`

计划包含：

- 测试目标 `goal`
- 目标 `target` 与允许 origin
- 授权范围 `authorization`
- HAR 测试数据 `test_data`
- HAR 请求依赖 `request_dependencies`
- 步骤、工具、参数、断言、依赖、风险、验收条件
- 工具和参数白名单

示例步骤：

1. `har.inspect`：读取并检查 HAR，无网络副作用
2. `api.replay`：真实回放 3 个请求，断言状态 200
3. `engine.run.k6`：生成并真实执行 k6，保存原始结果和统一报告

## 6. 真实工具调用记录

### k6 任务

任务：`phase4-e2e-k6-20261028`

| 步骤 | 工具 | 副作用 | 状态 | 运行 ID |
|---|---|---|---|---|
| `inspect-har` | `har.inspect` | 否 | completed | - |
| `api-replay` | `api.replay` | 是 | completed | `run_20261028001448_f4eba0` |
| `engine-k6` | `engine.run.k6` | 是 | completed | `engine_20261028001448_phase4-e2e-k_engine-k6` |

### JMeter 任务

任务：`phase4-e2e-jmeter-20261028`

| 步骤 | 工具 | 副作用 | 状态 | 运行 ID |
|---|---|---|---|---|
| `inspect-har` | `har.inspect` | 否 | completed | - |
| `api-replay` | `api.replay` | 是 | completed | `run_20261028001613_ea1c1f` |
| `engine-jmeter` | `engine.run.jmeter` | 是 | completed | `engine_20261028001613_phase4-e2e-j_engine-jmeter` |

完整记录见 `evidence/phase4/*/state-summary.json`。

## 7. 端到端结果

| 任务 | 引擎 | 请求 | 通过 | 失败 | HTTP |
|---|---|---:|---:|---:|---|
| `phase4-e2e-k6-20261028` | k6 `v1.8.2` | 3 | 2 | 1 | `200/200/500` |
| `phase4-e2e-jmeter-20261028` | JMeter `5.6.3` | 3 | 2 | 1 | `200/200/500` |

两个任务状态均为 `succeeded`。这表示编排流程完整执行；测试结果中仍有 1 个由 fixture 故意制造的 HTTP 500，报告没有把该失败改写为通过。

统一报告、原始 k6 summary、JMeter JTL、stdout/stderr 和 API replay 报告位于 `evidence/phase4/`。

## 8. 失败分析示例

真实报告生成的事实：

- Replay 报告：3 请求，2 通过，1 失败
- `GET /api/fail` 返回 HTTP 500
- k6/JMeter 报告：3 请求，2 通过，1 失败

推断：

- 目标服务至少对一个请求返回了服务端错误

待验证假设：

- 5xx 可能来自下游依赖、测试数据、认证状态或应用缺陷；报告本身不能确认具体原因
- 引擎失败可能来自目标行为、生成脚本或关联数据；需要对照 stderr、原始结果和单请求回放

建议：

- 在授权目标日志中追踪第一个 5xx 请求，并与 replay 请求和响应预览对照
- 保留报告和原始证据用于回归比较

## 9. 测试与安全覆盖

```text
pnpm typecheck  -> passed
pnpm test       -> 40 passed / 8 skipped
```

已覆盖：

- 非法计划、未知 Shell 工具、未知参数、未授权目标
- 模型不可用、模型返回非法 JSON
- 确认缺失、重复创建、重复执行
- 工具异常、参数非法
- 任务取消、运行中取消
- 已完成步骤跳过、副作用步骤需显式重试
- 从 task artifact 按 run ID 读取报告
- 不调用 AI 的确定性 CLI

实际 Harness 插件加载验证：

- 成功注册 13 个工具（10 个 Agent 编排工具 + 3 个原确定性工具）
- `test_agent_plan` 在 `use_model: false` 时成功返回 `model_status: "unavailable"` 和确定性计划
- `test_agent_run` 在没有 approval 服务时失败关闭，任务保持 `awaiting_confirmation`，工具调用记录为 0

## 10. 剩余问题

- 本次环境未连接可用的真实模型网关，因此“模型正面生成计划/增强分析”只验证了真实 API 接线、抽象和失败降级路径，未完成正面模型输出验收。
- Harness 正面审批 answerer 未在当前无 UI 验收环境中走通；fail-closed 路径已实际验证。
- 沙箱内 fixture 网络测试仍会跳过；真实外部 fixture 闭环已另行完成。
- 任务状态当前以 `succeeded` 表示编排完成，测试断言失败保存在报告和分析中，没有额外引入“测试通过/失败”独立顶层枚举。
