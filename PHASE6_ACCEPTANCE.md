# 第六阶段验收记录：测试能力扩展与白盒分析

验收日期：2026-10-28

结论：通过。UI 自动化、统一测试资产、Java 源码/WAR 白盒分析、候选测试生成与真实执行证据链已完成；第三至第五阶段回归通过。第六阶段完成后停止，未进入第七阶段。

## 1. 前置复核

| 前置项 | 状态 | 证据 |
|---|---|---|
| 第三阶段真实执行闭环 | 通过 | `PHASE4_ACCEPTANCE.md` 前置复核及 `evidence/phase4/` |
| 第四阶段 Agent 编排 | 通过 | `PHASE4_ACCEPTANCE.md` |
| 第五阶段桌面应用 | 通过 | `PHASE5_ACCEPTANCE.md` |
| Harness 核心 | 未修改 | `deepseek-harness` Git status 仅未跟踪 `scratch-plugin/` |
| CLI 独立能力 | 通过 | HAR、API、UI、code、asset、coverage、k6/JMeter CLI 实测 |
| 当前测试 | 通过 | `CI=true pnpm typecheck`；全量测试见第 8 节 |

## 2. 架构与实际修改

新增模块：

- UI 自动化：`src/ui/types.ts`、`src/ui/validation.ts`、`src/ui/runner.ts`、`src/ui/service.ts`
- 统一资产：`src/assets/types.ts`、`src/assets/service.ts`
- Java/WAR 分析：`src/code/types.ts`、`src/code/classfile.ts`、`src/code/java-analyzer.ts`、`src/code/service.ts`
- 覆盖与候选：`src/coverage/types.ts`、`src/coverage/service.ts`
- 桌面接入：`src/desktop/app-service.ts`、`src/desktop/types.ts`、`desktop/main.ts`、`desktop/preload.ts`、`desktop/renderer/app.ts`
- CLI 接入：`src/cli/ui.ts`、`src/cli/code.ts`、`src/cli/asset-coverage.ts`、`src/cli/index.ts`
- Agent 接入：`src/agent/types.ts`、`src/agent/plan.ts`、`src/agent/planner.ts`、`src/agent/tools.ts`

构建与安全：

- `scripts/build-desktop.mjs`
- `scripts/package-desktop.mjs`
- `desktop/electron-builder.mjs`
- `src/desktop/security.ts`

fixture 与样例：

- `fixtures/ui-site/`
- `fixtures/ui_server.py`
- `fixtures/java-project/`
- `fixtures/java-project/orders.har`
- `fixtures/java-war-fixture/`
- `scripts/build-java-war-fixture.mjs`
- `samples/ui-cases/*.json`

测试：

- `tests/unit/ui-validation.spec.ts`
- `tests/integration/ui-runner.spec.ts`
- `tests/desktop/ui-case-service.spec.ts`
- `tests/desktop/asset-service.spec.ts`
- `tests/unit/java-analyzer.spec.ts`
- `tests/unit/coverage-service.spec.ts`
- `tests/integration/coverage-execution.spec.ts`
- `tests/integration/agent-code-analysis.spec.ts`
- `tests/desktop/security.spec.ts`

文档与证据：

- `README.md`
- `PHASE5_ACCEPTANCE.md`
- `PHASE6_ACCEPTANCE.md`
- `evidence/phase6/README.md`
- `evidence/phase6/**`

## 3. 任务 6.1：UI 自动化

| 要求 | 状态 | 说明 |
|---|---|---|
| 集成成熟浏览器引擎 | 通过 | Playwright 1.61 + 本机 Chrome，不重写浏览器控制 |
| 导航/点击/输入/选择/等待/断言 | 通过 | schema、runner 与真实用例验证 |
| 录制 JSON 导入或 Agent 候选 | 通过 | 录制 JSON 导入生成版本化 UI 用例 |
| 定位器校验 | 通过 | 拒绝非法 role、unsafe locator、跨 origin、重复 step id |
| 执行日志/失败截图/报告 | 通过 | 真实 PNG 与 JSON 报告 |
| 用户编辑与独立执行 | 通过 | 桌面编辑器 + CLI `ui run` |
| 接入运行 ID 与报告体系 | 通过 | 桌面任务 `ui_20261028024103_ee9cdb` |
| 本地业务场景 | 通过 | 登录、查询、表单提交、下游失败、故意失败截图 |

真实结果：

- `ui_20261028005552_958255`：passed，11/11
- `ui_20261028005556_410565`：passed，8/8
- `ui_20261028005559_a967c0`：failed，7/8，生成真实截图
- `ui_20261028024103_ee9cdb`：桌面服务链路 passed，11/11

## 4. 任务 6.2：统一测试资产管理

| 要求 | 状态 | 说明 |
|---|---|---|
| API/UI/性能统一组织 | 通过 | `test-agent.asset/v1` |
| 用例版本与环境配置 | 通过 | 不可变 version + `environment.variable_refs` |
| 凭据引用 | 通过 | 仅允许 opaque reference，拒绝明文 secret |
| 运行/日志/报告关联 | 通过 | `runs.json` 保存 run id、task id、report、logs |
| 重复执行 | 通过 | 同一 API 资产两次真实执行均 2/2 通过 |
| 历史比较 | 通过 | `asset-repeat-comparison.json`，缺失指标为 null |
| 保留原生格式 | 通过 | HAR、UI JSON、k6 JS、JMX 不强制转换 |
| 迁移/兼容策略 | 通过 | `scanExisting()` 从现有项目发现并登记资产，不破坏源文件 |

真实运行：

- `run_20261028010722_571ec5`
- `run_20261028010722_6bfbc0`

## 5. 任务 6.3：Java 源码与 WAR 分析

### 源码

`fixtures/java-project` 实测：

- 4 source files / 4 classes
- Spring endpoints 2：`GET /api/orders/{id}`、`POST /api/orders`
- static branches 5
- exceptions 3
- uncertainties 3
- `coverage.measured = false`

证据包含文件、类、方法和行号；Reflection 与框架路由不确定性不会伪装成确定调用链。

### WAR

`fixtures/java-war-fixture/demo.war` 实测：

- 归档安全清单 3 entries，CRC 校验通过
- class 1、config 1、nested JAR 1
- 解析出 `com.example.war.DemoService.choose` 字节码 if 分支及方法调用
- endpoint 数量为 0：不根据缺失源码或注解参数臆造 mapping
- nested JAR 标记 `missing-dependency`
- `coverage.measured = false`

限制：不反编译为源码；动态调用、依赖内部调用、混淆和缺失行号不会被宣称完整还原。

## 6. 任务 6.4：覆盖分析与智能补测

覆盖状态只允许：

- `covered`：runtime coverage 明确命中且为 true
- `uncovered`：runtime coverage 明确命中且为 false
- `not_measured`：没有 runtime evidence

本次没有 Java runtime coverage 输入，因此：

```json
{
  "measured": false,
  "percentage": null,
  "covered_branches": 0
}
```

候选执行：

- 分析：`coverage_20261028010518_aa7275`
- candidate：`candidate-source_20261028010348_ce610c-c5cbb4f632`
- 真实 run：`run_20261028010518_32bf64`
- 结果：passed，GET `/api/orders/ORD-1001` HTTP 200
- coverage assertion：`not_measured`

保留的真实失败诊断：

- `run_20261028010424_fa8743` 复用旧 8089 fixture 时返回 HTTP 404，任务状态 `test_failed`；报告未被改写为通过。

## 7. 任务 6.5：服务端评估

结论：暂不建设完整服务端。当前需求是单机本地测试工作台，没有明确多人协作、统一调度、远程执行或集中报告管理需求。

未来边界：

- 执行器接口保留在 `TaskService` / engine executor 之下，可替换为远程队列 worker。
- 报告与任务记录已经是 JSON 文件，可迁移到带权限的集中存储。
- 远程化时必须补认证、授权、租户隔离、任务队列、审计、资源限额、密钥引用、节点心跳和结果保留策略。
- 桌面端不应直接访问远程数据库，仍通过应用服务协议调用。

## 8. 测试与回归

```sh
CI=true pnpm typecheck
CI=true pnpm test
CI=true pnpm vitest run tests/integration/ui-runner.spec.ts tests/integration/coverage-execution.spec.ts
```

结果：

- typecheck：通过
- 沙箱内全量：20 个测试文件通过，4 个文件因本地网络限制跳过；66 passed / 12 skipped
- 沙箱外真实 UI/候选执行：2 个文件、4 个测试全部通过
- Java/WAR：3 passed
- 覆盖服务：3 passed
- 统一资产：3 passed
- Agent code analysis + plan：9 passed
- UI 校验与桌面服务相关套件：全部通过
- k6/JMeter 真实 CLI：均完成，3 请求 / 2 通过 / 1 预期失败
- 桌面 build/package/App smoke：通过

## 9. 安全边界

- UI 导航仅允许声明 origin，页面请求通过 route guard 阻止未授权 origin。
- UI 输入值报告为 `[input value redacted]`，不写入普通报告。
- HAR、日志、异常和 Agent 输出使用敏感信息脱敏。
- 项目配置拒绝 URL credential、敏感 header 和越界值。
- 项目内路径会解析最近存在父级的真实路径，symlink 不能把 artifact/executable/source 指到项目外。
- Agent 仅 allowlist 工具，没有 shell 或任意命令工具。
- Java 分析只读本地文件；WAR 有大小、条目数和 CRC 限制。
- 真实业务系统必须先配置 authorization scope 并确认。

最终 ZIP SHA256：

```text
3ec0e860fc723e286c35c816661bfe409e711edc6d6d1655c37d6fb4cf77323e
```

## 10. 剩余问题

- 无可用 Java runtime coverage 文件，因此覆盖率百分比和“分支已覆盖”均为未测量，不宣称提升。
- 桌面无可用 Harness 模型网关；Agent 只能生成确定性计划，`model_status` 为 unavailable。
- WAR 嵌套 JAR 只清单不内调，依赖内部调用链未解析。
- 静态 Java 解析器面向常见 Spring/Servlet 代码，不是完整 Java 编译器前端；复杂泛型、Lombok、注解处理器生成代码可能产生 uncertainty。
- macOS 包未签名/未公证。
- 未对真实业务系统执行测试；所有网络验收均使用本地授权 fixture。
