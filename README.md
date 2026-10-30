# test-agent

DeepSeek Harness 测试插件：从浏览器 HAR 生成确定性 API 回放、k6/JMeter 脚本，并通过受控 Agent 编排完成“计划 -> 校验 -> 用户确认 -> 真实执行 -> 报告分析 -> 安全恢复”。

核心确定性能力不依赖大模型。Harness 模型只用于生成计划和增强失败分析；模型不可用时，插件明确返回 `model_status: "unavailable"`，不会伪造模型结果或执行报告。

## 固定 Harness 基线

| 项 | 值 |
|---|---|
| commit | `1f81c047fc48fa190a683e469daa699857e9afe8` |
| tag | `dsh-v0.2.1-rc.3` |
| Harness 版本 | `@deepseek-ai/dsh-root@0.2.1-rc.3` |
| Cordis | `@deepseek-ai/cordis@4.0.5` |
| dsh-tools | `@deepseek-ai/dsh-tools@0.2.1-rc.3` |
| Node.js 要求 | `^22.19.0 || >=24.0.0` |
| pnpm 要求 | `11.28.5` |

本地 checkout 固定在该提交和 tag，未修改 Harness 核心源码。实际验收环境为 Node `v24.22.0`、pnpm `11.25.0`。

## 安装与 fixture

```sh
pnpm install --frozen-lockfile
TEST_AGENT_FIXTURE_PORT=8089 python3 fixtures/server.py
```

`fixtures/server.py` 的真实行为：

- `GET /api/health?verbose=true` -> HTTP 200
- `POST /api/echo` -> HTTP 200
- `GET /api/fail` -> HTTP 500

## 确定性 CLI（不调用 AI）

```sh
pnpm cli har inspect samples/demo.har
pnpm cli api replay samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli generate k6 samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli generate jmeter samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli generate postman samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli engine k6 samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli engine jmeter samples/demo.har --base-url http://127.0.0.1:8089
pnpm cli report --run-id <RUN_ID>
```

## 第四阶段：Agent 测试编排

编排流程：

1. 用户描述测试目标。
2. Harness 当前 Agent 用其实际 provider/model 生成 `test-agent.plan/v1`；CLI 可生成确定性计划，模型状态会明确标为不可用。
3. 计划经过 schema、授权、工具白名单、参数、依赖、风险与验收条件校验。
4. 创建持久化任务并生成一次性确认 token。
5. 执行前必须确认。Harness 工具使用真实 `ctx.approval` 服务；没有审批通道时 fail closed。
6. 编排器按计划调用受控工具，跳过已完成步骤，保存运行 ID、工具调用、结果、artifact 和错误。
7. 分析器从真实报告提取事实，并区分事实、有证据的推断、待验证假设和建议。

### CLI

```sh
pnpm cli agent plan samples/demo.har \
  --base-url http://127.0.0.1:8089 \
  --goal "验证健康检查、回显与预期 500 失败" \
  --task-id phase4-demo-k6 \
  --engine k6 \
  --output samples/agent-plan.json

pnpm cli agent validate --plan samples/agent-plan.json
pnpm cli agent create --plan samples/agent-plan.json

# 使用 create 输出中的 confirmation.token
pnpm cli agent confirm phase4-demo-k6 --token <TOKEN>
pnpm cli agent execute phase4-demo-k6 --confirm <TOKEN>

pnpm cli agent status phase4-demo-k6
pnpm cli agent list
pnpm cli agent analyze phase4-demo-k6
pnpm cli agent cancel phase4-demo-k6
pnpm cli agent resume phase4-demo-k6
```

任务 ID 已存在时不会覆盖。一次成功执行也不能重复执行，需创建新任务。

### 结构化计划

示例：`samples/agent-plan.json`。关键字段：

- `goal`：测试目标
- `target.base_url` / `allowed_origins` / `allowed_paths`
- `authorization`：目标授权范围和确认状态
- `test_data`：HAR 或 fixture 等数据来源
- `request_dependencies`：HAR 请求索引之间的 cookie、token、资源或顺序依赖
- `steps[].tool`：仅允许受控工具目录中的工具
- `steps[].arguments`：按工具白名单校验，未知参数会被拒绝
- `steps[].assertions`：HTTP 状态、JSONPath、内容、耗时断言
- `steps[].depends_on`：只能依赖更早的步骤
- `steps[].risk`：副作用与确认要求
- `steps[].acceptance_criteria`：验收条件

允许的工具：

- `har.inspect`
- `api.replay`
- `script.generate.k6`
- `script.generate.jmeter`
- `engine.run.k6`
- `engine.run.jmeter`
- `report.read`

没有 shell、通用命令执行或任意可执行文件工具。

### 状态、取消与恢复

```text
.test-agent/
  tasks/<task_id>/
    state.json
    execution.lock
    cancel.request
    artifacts/
      <run_id>.report.json
      <run_id>.k6.json
      <run_id>.jmeter.jtl
      <run_id>.*.stdout.log
      <run_id>.*.stderr.log
```

- 状态写入使用临时文件 + rename。
- 执行锁防止同一任务并发执行；旧进程锁会按 PID/主机/时效清理。
- 已完成步骤恢复时跳过。
- 失败、取消或中断的副作用步骤不会被自动重放；必须显式执行 `resume --retry-uncertain <step-id>`。
- `cancel` 可取消排队任务；运行中任务会在下一个取消检查点终止引擎进程并记录 `cancelled`。

### Harness 插件加载

在 Harness checkout 根目录创建 `scratch-plugin/cordis.yml`：

```yaml
- insert:
    - id: test-agent
      name: '/Users/ztl/Downloads/AIProject/test-agent/src/plugin/index.ts'
```

```sh
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

新增的 Agent 工具：

- `test_agent_plan`
- `test_agent_validate_plan`
- `test_agent_create_task`
- `test_agent_run`
- `test_agent_execute_task`
- `test_agent_resume_task`
- `test_agent_cancel_task`
- `test_agent_task_status`
- `test_agent_list_tasks`
- `test_agent_analyze_task`

保留的原确定性工具：

- `test_har_inspect`
- `test_api_replay`
- `test_script_generate`

插件运行时可用以下环境变量改变状态和输出目录：

```sh
TEST_AGENT_WORKING_DIRECTORY=/path/to/workspace
TEST_AGENT_STATE_ROOT=/path/to/workspace/.test-agent
TEST_AGENT_OUTPUT_DIR=/path/to/workspace/output
```

### 模型行为

- Harness 工具从当前 `exec.agent.options`（必要时回退到最近请求 header）读取真实 provider/model。
- 模型返回非法 JSON、非法计划或不支持的 Shell 工具时，不会据此执行；插件返回明确标注的确定性 fallback 计划并记录 `model_error`。
- 没有可用模型路由时不发起伪造调用，计划结果标记为 `model_status: "unavailable"`。
- 失败分析先由真实报告生成确定性事实，再可选地由模型补充推断、假设和建议。

## 真实验收结果

2026-10-28 在沙箱外启动 `127.0.0.1:8089` fixture 并执行已确认任务：

| 任务 | 引擎 | 结果 | 运行 ID |
|---|---|---|---|
| `phase4-e2e-k6-20261028` | k6 `v1.8.2` | 3 请求，2 通过，1 失败；HTTP `200/200/500` | `engine_20261028001448_phase4-e2e-k_engine-k6` |
| `phase4-e2e-jmeter-20261028` | JMeter `5.6.3` | 3 请求，2 通过，1 失败；HTTP `200/200/500` | `engine_20261028001613_phase4-e2e-j_engine-jmeter` |

可审计证据保存在 `evidence/phase4/`：

- 统一报告
- 原始 k6 summary / JMeter JTL
- stdout / stderr
- API replay 报告
- 工具调用、步骤状态、运行 ID 和失败分析摘要

详细验收记录见 `PHASE4_ACCEPTANCE.md`。

## 测试

```sh
pnpm typecheck
pnpm test
```

第四阶段当时结果：`40 passed / 8 skipped`。跳过项是沙箱内无法绑定/连接 fixture 的网络测试；真实外部 fixture 闭环已单独完成并保存在证据目录。

覆盖重点：

- 计划 schema、未知工具、未知参数、授权和请求依赖
- 模型不可用、模型返回非法 JSON
- 确认缺失、重复创建、重复执行
- 工具异常、参数非法
- 运行中取消
- 已完成步骤跳过、副作用步骤显式重试
- 从 task artifact 按 run ID 读取报告
- 不调用 AI 时的确定性 CLI

## 安全边界与剩余问题

- 仅注册受控测试工具，不暴露 shell。
- 目标 origin 必须显式配置；默认只允许 `http://127.0.0.1:8089`。
- 重定向默认禁止，响应体和 HAR/请求体有大小上限，敏感字段会脱敏。
- Harness 的正面审批流需要在带真实审批 answerer 的运行环境中验证；无审批通道的 fail-closed 行为已实际验证。
- 模型驱动计划/增强分析的抽象和失败路径已测试，但本次未连接可用的真实模型网关完成正面模型调用验收。
- 沙箱内 Replay 网络测试会跳过；外部真实测试已完成，不能把跳过项或网络失败报告当作成功结果。
- 第六阶段验收完成后停止，未进入第七阶段。

## 第五阶段：本地桌面工作台

桌面端选择 Electron：现有核心是 Node.js/TypeScript，主进程可以直接复用 HAR 解析、API replay、k6/JMeter 生成执行、任务记录、报告读取和 Agent 编排；Tauri 会引入 Rust 工具链与跨语言边界。渲染进程处于 sandbox + context isolation，无 Node 能力，只能通过 preload 暴露的窄 IPC 调用主进程应用服务。

```sh
# 开发启动
CI=true pnpm desktop:run

# 构建与 smoke
CI=true pnpm desktop:build
CI=true pnpm desktop:smoke

# macOS arm64 未签名本地包
CI=true pnpm desktop:package
'release/mac-arm64/Test Agent Workbench.app/Contents/MacOS/Test Agent Workbench' --smoke-test
```

打包产物：

- App：`release/mac-arm64/Test Agent Workbench.app`
- ZIP：`release/Test Agent Workbench-0.1.0-arm64-mac.zip`

桌面功能覆盖项目创建/打开/切换、HAR 导入、请求查看、API replay、k6/JMeter 检测与脚本生成、真实执行、取消/超时/异常恢复、日志与历史报告、Agent 计划确认和工具调用记录。所有测试核心仍由主进程服务调用，CLI 保持独立。详细验收见 `PHASE5_ACCEPTANCE.md`。

## 第六阶段：UI 自动化、资产、白盒与覆盖

### UI 自动化

```sh
CI=true pnpm cli ui validate samples/ui-cases/login-search-submit.json
TEST_AGENT_UI_PORT=8090 python3 fixtures/ui_server.py &
CI=true pnpm cli ui run samples/ui-cases/login-search-submit.json --output-dir output/ui
```

- 使用 Playwright 1.61 和本机 Chrome。
- 支持 navigate/click/fill/select/wait/assert、录制 JSON 导入、版本化编辑、origin 白名单、取消、控制台日志、失败截图和真实报告。
- 本地 fixture 覆盖登录、查询、表单提交、下游失败和故意断言失败截图。

### 测试资产、代码分析与覆盖

```sh
# Java 源码 / WAR
CI=true pnpm cli code analyze fixtures/java-project --output output/java-source.json
CI=true pnpm cli code analyze fixtures/java-war-fixture/demo.war --output output/java-war.json

# 已有项目中扫描、重复执行、历史比较
CI=true pnpm cli asset scan --project <project-dir>
CI=true pnpm cli asset run <asset-id> --project <project-dir>
CI=true pnpm cli asset compare <asset-id> --project <project-dir>

# 静态/运行时覆盖关联与候选执行
CI=true pnpm cli coverage analyze <java-source.json> --project <project-dir>
CI=true pnpm cli coverage execute <coverage-id> <candidate-id> --project <project-dir>
```

统一资产保留原生格式：HAR 不改写为脚本，UI 用 JSON 用例，性能保留 k6 JS 与 JMeter JMX。资产元数据包含版本、环境/凭据引用、执行记录、日志和报告关联；凭据只允许 `env://`、`keychain://`、`vault://` 引用，不保存明文。

Java 分析是确定性工具，不依赖模型。源码输入记录类、方法、Spring 映射、调用、分支、异常和文件/行号证据；WAR 输入先安全清单和 CRC 校验，再解析 class 常量池/字节码/行号表。Reflection、嵌套 JAR、混淆和缺依赖都会标记不确定性；WAR 不推断源码，也不宣称完整运行时调用链。

覆盖分析区分 `static`、`runtime`、`not_measured`。没有运行时覆盖时百分比为 `null`；执行候选只证明测试请求执行，不证明目标分支已覆盖。候选必须附带 runtime coverage 才能标记 covered/uncovered。

第六阶段真实证据见 `evidence/phase6/` 和 `PHASE6_ACCEPTANCE.md`。

## 第六阶段测试结果

```sh
CI=true pnpm typecheck
CI=true pnpm test
```

最近全量结果：`66 passed / 12 skipped`。跳过项为沙箱内禁止本地 bind/connect 的网络测试；对应真实 Playwright、API replay、k6 与 JMeter 闭环已在沙箱外执行并保存证据。

## 服务端评估结论

当前没有明确的多人协作、统一调度、远程执行或集中管理需求，因此不实现完整服务端。保留主进程应用服务/执行器边界，未来可把 `TaskService`、报告存储和审批审计迁移到受认证保护的队列服务；桌面端仍通过显式接口调用执行器。

## 第七阶段：真实试点、模型网关与端到端验收

第七阶段审计与验收记录：

- `PHASE7_AUDIT.md`
- `PHASE7_PILOT_GUIDE.md`
- `PHASE7_ACCEPTANCE.md`
- `evidence/phase7/README.md`

新增重点：

- 桌面模型网关配置，支持 OpenAI-compatible Provider、Base URL、模型名、timeout、max tokens 和 macOS `safeStorage` 加密密钥。
- 模型输出必须通过结构化计划 schema 和工具白名单；副作用执行仍需人工确认。
- API 报告响应预览与断言证据脱敏，任务报告保留 `error_kind`。
- API replay 取消和超时分别记录为 `cancelled` / `timeout`。
- Java 源码调用记录参数表达式；WAR 字节码调用记录参数 descriptor，并明确这只是类型证据而非运行时实参。
- 一个自动化端到端闭环覆盖 HAR 导入、代码分析、覆盖候选、确认门禁、真实 API/UI/k6、资产历史和可追溯报告。

模型与真实业务限制：

- 当前只验证了本地 OpenAI-compatible HTTP fixture；外部商用模型因未配置真实密钥，状态为未验证。
- 当前 Java 试点使用自建 fixture；真实业务项目、WAR 和目标系统未授权提供，状态为未验证。

## 第八阶段：MVP 试运行

第八阶段将前述能力收敛为本机 Mac MVP，并补充：

- `PHASE8_BASELINE.md`：当前可运行能力、限制、P0/P1 风险和启动步骤。
- `MVP_QUICKSTART.md`：安装、工作区、HAR、API、报告、模型、常见错误和备份。
- `MVP_LIMITATIONS.md`：fixture 与真实业务验证边界、依赖外部条件、安全限制。
- `MVP_ACCEPTANCE.md`：本地 MVP 验收结论和后续优先级。
- `evidence/phase8/README.md`：API/UI/性能/白盒/模型不可用证据。

第八阶段修复 CLI P0：测试失败退出码不再被入口覆盖。当前本地个人试用通过；真实业务 API/UI/性能/白盒和外部商用模型仍未验证。

## 第九阶段：真实业务接入加固

第九阶段新增：

- Agent 输入根限制与桌面 Java/WAR 授权记录。
- 公网域名解析到本机/内网地址的失败关闭策略。
- macOS 安全存储凭据：Bearer、Cookie、Basic Auth、自定义 Header。
- API replay 运行时数据关联：JSONPath 提取、`${variable}` 替换、目标 Header 注入和报告证据。
- `.test-agent` 过期原子写临时文件清理。
- macOS 签名、公证、staple 脚本。

文档：

- `PHASE9_AUDIT.md`
- `PHASE9_ACCEPTANCE.md`
- `PHASE9_REAL_API_TRIAL.md`
- `MACOS_RELEASE.md`
- `evidence/phase9/README.md`

真实业务 API 仍未提供授权环境，试点状态为待完成；本地 fixture 已完成登录 token -> 创建动态对象 -> 查询对象的真实回环闭环。
