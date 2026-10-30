# 第五阶段验收记录：Test Agent 桌面工作台

验收日期：2026-10-28

结论：通过。Electron 桌面工作台可以启动，项目、HAR、API、性能、任务、报告、日志和 Agent 服务链路已接入现有测试核心；CLI 保持独立。第六阶段开始前，本阶段遗留的桌面实现和打包缺口已补齐并复验。

## 1. 前置复核

- 第三阶段真实 API、k6、JMeter、任务记录和报告闭环已存在。
- 第四阶段 `PHASE4_ACCEPTANCE.md` 记录编排闭环和真实执行证据。
- Harness checkout 仍为 `1f81c047fc48fa190a683e469daa699857e9afe8` / `dsh-v0.2.1-rc.3`。
- `deepseek-harness/` 核心源码未修改；仅保留插件加载用未跟踪 `scratch-plugin/`。
- 项目根目录本身不是 Git 仓库，因此阶段改动以文件清单和测试证据验收。

## 2. 技术选型

选择 Electron 44.7.0：

- 现有核心为 Node.js 24 + TypeScript，主进程可直接复用模块与子进程控制。
- Electron 对本地文件选择、`AbortSignal`、子进程、任务收尾和 macOS 打包支持成熟。
- Tauri 需要本机未安装的 Rust 工具链，并新增跨语言边界；未采用。
- UI 不重写测试核心。Renderer sandbox + context isolation + no Node，只通过 preload 暴露窄 IPC。

## 3. 实际修改文件

### 桌面应用

- `desktop/main.ts`
- `desktop/preload.ts`
- `desktop/renderer/index.html`
- `desktop/renderer/app.ts`
- `desktop/renderer/styles.css`
- `desktop/electron-builder.mjs`

### 应用服务与安全

- `src/desktop/types.ts`
- `src/desktop/security.ts`
- `src/desktop/project-service.ts`
- `src/desktop/engine-discovery.ts`
- `src/desktop/task-service.ts`
- `src/desktop/agent-service.ts`
- `src/desktop/app-service.ts`

### 构建、测试与文档

- `scripts/build-desktop.mjs`
- `scripts/prepare-electron.mjs`
- `scripts/run-desktop.mjs`
- `scripts/package-desktop.mjs`
- `package.json`
- `tests/desktop/project-service.spec.ts`
- `tests/desktop/task-service.spec.ts`
- `tests/desktop/security.spec.ts`
- `README.md`
- `PHASE5_IMPLEMENTATION_PLAN.md`
- `PHASE5_ACCEPTANCE.md`

## 4. 功能验收

| 验收项 | 状态 | 证据 |
|---|---|---|
| 桌面开发版启动 | 通过 | `CI=true pnpm desktop:smoke` 输出 `TEST_AGENT_DESKTOP_SMOKE=ready` |
| 打包 App 启动 | 通过 | `release/mac-arm64/Test Agent Workbench.app --smoke-test` 输出 `TEST_AGENT_DESKTOP_SMOKE=ready` |
| 创建/打开/切换项目 | 通过 | `tests/desktop/project-service.spec.ts` |
| 导入 HAR 并脱敏 | 通过 | 同上；Authorization 等敏感值不会进入项目 HAR |
| 查看 URL/方法/请求头/请求体 | 通过 | `ProjectService.requests()` 与 renderer API 实验台 |
| 配置环境、断言、关联和授权 | 通过 | 项目配置校验测试与真实 replay 配置 |
| API replay | 通过 | 第六阶段 `evidence/phase6/coverage-evidence-2/output/` 真实 run |
| k6/JMeter 检测与脚本生成 | 通过 | `tests/desktop/task-service.spec.ts`、`tests/integration/generators.spec.ts` |
| 真实 k6/JMeter 执行 | 通过 | `evidence/phase6/engines/` |
| 任务状态/运行 ID/开始结束时间 | 通过 | `tests/desktop/task-service.spec.ts` 与项目任务 state |
| 日志、历史任务、报告读取 | 通过 | `TaskService.listTasks/getTask/taskLogs` 测试 |
| 启动失败、重复启动、取消、异常退出 | 通过 | `tests/desktop/task-service.spec.ts` |
| 超时与引擎错误分类 | 通过 | `tests/integration/engines.spec.ts` |
| Agent 计划确认与工具记录 | 通过 | `tests/desktop/task-service.spec.ts`、`tests/integration/agent-orchestrator.spec.ts` |
| 模型不可用时确定性能力可用 | 通过 | Agent 明确 `model_status: unavailable`；无 AI CLI/引擎仍通过 |
| 敏感信息脱敏与路径限制 | 通过 | `tests/desktop/security.spec.ts`、`tests/security/security.spec.ts` |
| CLI 独立运行 | 通过 | `CI=true pnpm cli --help`、UI/code/engine CLI 实测 |
| macOS arm64 打包 | 通过 | `release/Test Agent Workbench-0.1.0-arm64-mac.zip` |

Smoke 验证会通过 renderer 调用 `window.testAgent.bootstrap()`，不是仅检查函数存在。

## 5. 构建与打包

```sh
CI=true pnpm desktop:build
CI=true pnpm desktop:smoke
CI=true pnpm desktop:package
'release/mac-arm64/Test Agent Workbench.app/Contents/MacOS/Test Agent Workbench' --smoke-test
```

产物：

- `release/mac-arm64/Test Agent Workbench.app`
- `release/Test Agent Workbench-0.1.0-arm64-mac.zip`

打包修复点：

- Playwright 不再强行压入单个 CJS；作为运行时依赖随 app.asar 分发。
- Electron builder 版本与实际 Electron 44.7.0 一致。
- 未签名、未公证；首次启动可能需要 macOS Gatekeeper 手动允许。

最终 ZIP SHA256：

```text
3ec0e860fc723e286c35c816661bfe409e711edc6d6d1655c37d6fb4cf77323e
```

## 6. 剩余问题

- 本地包未签名/未公证；分发到其他 Mac 前需要开发者证书与 notarytool。
- 文件选择对话框的人工点击路径未做自动化验收；对应主进程服务和 renderer API 已由测试与 smoke 验证。
- 桌面进程没有可用 Harness 模型网关，Agent 只提供确定性计划并明确标记模型不可用。
