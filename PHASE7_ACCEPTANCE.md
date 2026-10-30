# 第七阶段验收记录：真实项目试点与端到端闭环

验收日期：2026-10-28

结论：本地可重复试点与端到端闭环验收通过；两项外部场景未验证并明确保留：

1. 未收到真实业务 Java 项目、WAR、HAR、目标系统和授权说明，因此真实业务试点未验证。
2. 未配置外部商用模型网关密钥，因此外部 Provider 正面调用未验证。模型接入本身已用本地 OpenAI-compatible HTTP fixture 完成真实请求、schema 校验、确认门禁和失败降级验证。

## 1. 前置与审计

- Harness：`1f81c047fc48fa190a683e469daa699857e9afe8` / `dsh-v0.2.1-rc.3`，核心未修改。
- 第五阶段：`PHASE5_ACCEPTANCE.md` 复核，桌面实现存在。
- 第六阶段：`PHASE6_ACCEPTANCE.md` 与 `evidence/phase6/` 复核。
- 第七阶段审计：`PHASE7_AUDIT.md`。
- 审计发现的 P0 全部修复；未修复项均为 P1/P2 或明确未验证，不在本记录中伪装为通过。

## 2. 实际修改文件

### 安全与报告

- `src/desktop/security.ts`
- `src/api/replay.ts`
- `src/api/assertions.ts`
- `src/results/result.ts`
- `src/agent/planner.ts`
- `src/agent/plan.ts`
- `src/api/policy.ts`
- `src/desktop/project-service.ts`
- `tests/unit/report-redaction.spec.ts`
- `tests/unit/agent-plan.spec.ts`

### 模型网关

- `src/desktop/model-service.ts`（新增）
- `src/desktop/agent-service.ts`
- `src/desktop/app-service.ts`
- `src/desktop/types.ts`
- `desktop/main.ts`
- `desktop/preload.ts`
- `desktop/renderer/app.ts`
- `package.json`
- `tests/desktop/model-service.spec.ts`
- `tests/desktop/agent-model.spec.ts`
- `tests/integration/phase7-model-gateway.spec.ts`

### 任务生命周期与端到端

- `src/desktop/task-service.ts`
- `tests/integration/task-lifecycle.spec.ts`
- `tests/integration/phase7-end-to-end.spec.ts`

### Java/WAR 参数证据

- `src/code/types.ts`
- `src/code/java-analyzer.ts`
- `src/code/classfile.ts`
- `tests/unit/java-analyzer.spec.ts`

### 文档与证据

- `PHASE7_AUDIT.md`
- `PHASE7_PILOT_GUIDE.md`
- `PHASE7_ACCEPTANCE.md`
- `evidence/phase7/README.md`
- `evidence/phase7/**`
- `README.md`

## 3. 任务 7.1 审计结果

P0 修复：

| 问题 | 结果 | 验证 |
|---|---|---|
| API 报告/断言泄露敏感输出 | 通过 | `tests/unit/report-redaction.spec.ts` |
| 桌面无模型配置，模型状态硬编码不可用 | 通过 | 模型服务、Agent、本地 HTTP 网关测试 |
| 缺少单一端到端闭环测试 | 通过 | `tests/integration/phase7-end-to-end.spec.ts` |
| 打包 App 未实际调用 Playwright | 通过 | 开发版与打包 App `--smoke-ui` |
| API replay 取消/超时误标 `test_failed` | 通过 | `tests/integration/task-lifecycle.spec.ts` |

仍保留：

- P1-1 Agent 普通 path 工具允许计划中显式选择的绝对路径，后续需按 allowed input roots 收紧。
- P1-2 崩溃遗留 `.tmp` 清理未实现。
- P1-4 WAR 嵌套 JAR 不内省。
- P1-5 Java 解析器不是完整编译器前端。

## 4. 任务 7.2 Java/WAR 验证

### 源码 fixture

结果：通过。

- 4 个源码文件/类。
- 2 个 Spring endpoint。
- 5 个静态分支。
- 3 个异常路径。
- 3 个不确定性。
- `OrderController.findOrder -> service.find` 有文件、类、方法、行号、参数表达式 `id` 和 `parameter_evidence: source-text`。
- Reflection fixture 明确标记静态调用链不完整。
- `coverage.measured=false`。

命令：

```sh
CI=true pnpm cli code analyze fixtures/java-project \
  --output evidence/phase7/code/java-source-analysis.json
```

### WAR fixture

结果：通过。

- 安全清单 3 entries。
- class 1、config 1、nested JAR 1。
- 字节码方法、调用、if 分支和行号证据。
- `DemoService.choose -> DemoService.helper` 记录参数类型 `java.lang.String`，证据类型 `bytecode-descriptor`。
- endpoint 0，不根据缺失源码臆造。
- 嵌套 JAR 明确 `missing-dependency`，不伪装成已解析。
- 不执行 WAR 内应用代码。

命令：

```sh
CI=true pnpm cli code analyze fixtures/java-war-fixture/demo.war \
  --output evidence/phase7/code/java-war-analysis.json
```

### 真实业务项目

状态：未验证。没有用户提供授权样本；操作入口见 `PHASE7_PILOT_GUIDE.md`。

## 5. 任务 7.3 模型网关

实现：

- 桌面 Agent 页可配置 Provider、Base URL、模型名、chat path、timeout、max tokens。
- API Key 只在主进程处理，macOS `safeStorage` 加密存储；Renderer 只见 `hasApiKey`。
- 安全存储不可用时拒绝保存密钥。
- 外部 Base URL 必须 HTTPS；仅本地回环允许 HTTP。
- 不硬编码 API Key。
- 模型错误统一脱敏，区分 timeout、401/403、404、429、5xx、非法 JSON、空输出和截断。
- 模型输出进入既有 `test-agent.plan/v1` 校验、工具白名单和参数校验。
- 模型不能直接执行；副作用计划仍需人工确认。
- `code.analyze.java` 保持受控工具，无 shell。

验证：

| 场景 | 状态 | 证据 |
|---|---|---|
| 本地 OpenAI-compatible HTTP 网关 | 通过 | `evidence/phase7/model-gateway/model-gateway-summary.json` |
| 模型生成合法计划 | 通过 | plan hash `89cc308f61c59e75e76f0f8a5823660c39f3fdbfd1b45fb5da2d320aefa94787` |
| 未确认执行 | 通过 | 测试确认 tool call 0 |
| 非法模型 JSON | 通过 | 降级 deterministic |
| 模型不可用 | 通过 | deterministic plan / CLI / executor 回归 |
| 密钥明文落盘 | 未出现 | 配置和证据搜索无明文 key |
| 外部商用模型 | 未验证 | 本机无真实密钥/网关 |

## 6. 任务 7.4 端到端闭环

自动化场景：`tests/integration/phase7-end-to-end.spec.ts`。

已验证：

1. 导入 2 个请求 HAR。
2. Java fixture 分析。
3. Coverage 分析和候选生成。
4. 事实、推断、假设和证据来源写入 summary。
5. Agent 计划校验。
6. 未确认执行被拒绝且无 tool call。
7. 确认后执行 HAR inspect、API replay、k6。
8. API 资产重复执行和历史比较。
9. UI 资产真实 Playwright 执行。
10. 性能脚本生成并经真实 k6 执行。
11. 任务、run id、report、artifact、asset、code analysis、coverage 关联。
12. 无 runtime coverage 时 `percentage=null`。
13. 失败/限制保留，不改写结果。

关键证据：

- `evidence/phase7/e2e/evidence-summary.json`
- API runs：`run_20261028031325_327893`、`run_20261028031325_e236c8`
- Candidate：`run_20261028031325_27e3c1`
- UI：`ui_20261028031325_6f0a67`
- k6：`engine_20261028031326_a38b31`
- Agent：`agent_phase7_e2e`

## 7. 任务 7.5 桌面与发布

| 验收项 | 状态 | 证据 |
|---|---|---|
| 开发版 build | 通过 | `CI=true pnpm desktop:build` |
| 打包 | 通过 | `CI=true pnpm desktop:package` |
| 打包 App bootstrap | 通过 | `TEST_AGENT_DESKTOP_SMOKE=ready` |
| macOS 安全存储 | 通过 | `TEST_AGENT_SECURE_STORAGE=available` |
| 打包 App 内 Playwright/Chrome | 通过 | run `ui_20261028032750_2bd5ba`，2/2 |
| 项目创建/重开/HAR 脱敏 | 通过 | desktop project tests + e2e |
| API/UI/性能任务 | 通过 | phase7 e2e |
| 取消/超时 | 通过 | task lifecycle test |
| 代码/覆盖/报告页面接入 | 通过 | renderer API 与 service/e2e 测试 |
| 模型配置与失败提示 | 通过 | IPC/UI/service/model tests |
| 应用重启后资产和历史 | 通过 | ProjectService reopen 测试与资产 runs.json |
| 无权限/无网络所有分支 | 部分通过 | 网络失败、引擎错误、无模型已测；无权限目录和离线 macOS 权限弹窗未做完整 GUI 自动化 |
| 签名/公证 | 未验证/未执行 | `identity: null`，无证书与 notary 凭据 |

发布清单：

1. 准备 Developer ID Application 证书和 Team ID。
2. 启用 hardened runtime，最小 entitlements。
3. 配置 electron-builder signing，不再使用 `identity: null`。
4. notarytool 提交 ZIP/DMG 并保存 ticket。
5. `codesign --verify --deep --strict --verbose=2`。
6. `spctl --assess --type execute`。
7. 干净 macOS arm64 机器验证 Chrome、k6、JMeter、项目目录和输出目录权限。
8. 发布哈希与公证记录写入版本说明。

## 8. 测试与命令

```sh
CI=true pnpm typecheck
CI=true pnpm test
CI=true pnpm desktop:build
CI=true pnpm desktop:package
CI=true pnpm desktop:smoke
CI=true pnpm desktop:smoke-ui
'release/mac-arm64/Test Agent Workbench.app/Contents/MacOS/Test Agent Workbench' --smoke-test
'release/mac-arm64/Test Agent Workbench.app/Contents/MacOS/Test Agent Workbench' --smoke-ui
```

沙箱外真实网络测试：

```sh
CI=true pnpm vitest run tests/integration/phase7-end-to-end.spec.ts
CI=true pnpm vitest run tests/integration/phase7-model-gateway.spec.ts
CI=true pnpm vitest run tests/integration/task-lifecycle.spec.ts
CI=true pnpm vitest run tests/integration/ui-runner.spec.ts tests/integration/coverage-execution.spec.ts
```

最终结果见第 10 节。

## 9. 安全验收

- HAR 输入侧敏感 header/query/body 脱敏。
- API response preview、断言 expected/actual/error 脱敏。
- UI 输入值不进入报告。
- 模型 goal/scope 先脱敏再进入 prompt。
- target/model base URL 拒绝 credential、query 和 fragment。
- 普通 HTTPS model gateway 强制；HTTP 仅本地回环。
- API Key 不写源码、项目文件、renderer、普通日志或验收证据。
- Agent 工具白名单仍无 shell。
- 项目路径做 symlink canonical 校验。
- 报告保留真实失败、`error_kind` 和原始证据路径。

## 10. 最终结果与遗留

最终回归：

- `CI=true pnpm typecheck`：通过，exit code 0。
- `CI=true pnpm test`：23 个测试文件通过、7 个文件因沙箱网络限制跳过；`73 passed / 15 skipped`，exit code 0。
- 沙箱外最终回归：5 个测试文件、7 个测试全部通过，exit code 0；覆盖 phase7 E2E、模型网关、任务生命周期、真实 Playwright UI、候选 API 执行。
- `CI=true pnpm desktop:package`：通过，exit code 0。
- 打包 App 基础 smoke：通过，`TEST_AGENT_DESKTOP_SMOKE=ready`。
- macOS 安全存储：`TEST_AGENT_SECURE_STORAGE=available`。
- 打包 App Playwright smoke：run `ui_20261028032750_2bd5ba`，2/2 steps passed。
- 最终 ZIP：`release/Test Agent Workbench-0.1.0-arm64-mac.zip`。
- ZIP SHA256：`22ecbf8daccceb52d7988a496d52b19ade4337eb24fd36934cfda089333b9a95`。
- app.asar SHA256：`aa5ff90b54a63459e4fe9f0b261a98e9bce5b4202fa79748c1847b790f268df5`。
- 外部真实业务项目：未验证。
- 外部商用模型：未验证。
- WAR 嵌套 JAR：未内调。
- Java 完整语法解析：未覆盖复杂 Lombok/注解处理器场景。
- Agent allowed input roots：P1 待收紧。
- 崩溃临时文件清理：P1 待实现。
- macOS 签名/公证：未执行。
