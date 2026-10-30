# 第八阶段 Baseline 核实记录

核实时间：2026-10-28 12:32-12:35，Asia/Shanghai

## 1. 版本与 Git 状态

- 项目根目录 `/Users/ztl/Downloads/AIProject/test-agent` 不是 Git 仓库，无法提供根目录分支/diff；本阶段以实际文件和验收记录为准。
- Harness 子仓库：`/Users/ztl/Downloads/AIProject/test-agent/deepseek-harness`
- 分支/提交：`locked` / `1f81c047fc48fa190a683e469daa699857e9afe8`
- Tag：`dsh-v0.2.1-rc.3`
- Harness 工作区：仅有未跟踪 `scratch-plugin/`，核心源码未修改。
- 第七阶段文档和证据均存在：
  - `PHASE5_ACCEPTANCE.md`
  - `PHASE6_ACCEPTANCE.md`
  - `PHASE7_AUDIT.md`
  - `PHASE7_ACCEPTANCE.md`
  - `PHASE7_PILOT_GUIDE.md`
  - `evidence/phase7/README.md`

## 2. Baseline 命令结果

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `CI=true pnpm typecheck` | 0 | 通过 |
| `CI=true pnpm test` | 0 | 23 个测试文件通过，7 个文件因沙箱网络限制跳过；`73 passed / 15 skipped` |
| `CI=true pnpm desktop:package` | 0 | macOS arm64 App 与 ZIP 打包成功 |
| 打包 App `--smoke-test` | 0 | `TEST_AGENT_DESKTOP_SMOKE=ready`；`TEST_AGENT_SECURE_STORAGE=available` |
| 打包 App `--smoke-ui` | 0 | `TEST_AGENT_DESKTOP_UI_SMOKE=ready`；run `ui_20261028043408_a80f41`，2/2 steps passed |

说明：第一次输入 `--smoke-ui` 命令时 Shell 引号写错，exit 1 为 `unmatched '`，应用未启动；修正引号后成功。不计为应用故障。

当前产物：

- App：`release/mac-arm64/Test Agent Workbench.app`
- ZIP：`release/Test Agent Workbench-0.1.0-arm64-mac.zip`
- ZIP SHA256：`a84f4d9e25f166d23afe0a423158b347036ad052e6f4ee82d7a032342aee988c`
- app.asar SHA256：`aa5ff90b54a63459e4fe9f0b261a98e9bce5b4202fa79748c1847b790f268df5`

## 3. 实际可运行功能

### 桌面端

- 启动、退出、单实例锁、sandbox renderer、窄 IPC。
- 创建、打开、切换工作区；工作区 `project.json`、recent projects 持久化。
- HAR 导入、大小/条目限制、敏感输入脱敏和项目内保存。
- 请求列表和请求详情查看。
- API replay、任务状态、报告、失败详情和日志查看。
- k6/JMeter 检测、脚本生成、真实执行、取消、超时、历史记录。
- UI 用例导入/编辑/版本化保存/真实 Playwright 执行/失败截图。
- 资产扫描、执行、历史和比较。
- Java/WAR 分析、覆盖分析、候选执行。
- Agent 计划、确认门禁、工具调用记录和确定性分析。
- 模型 Provider/Base URL/model/timeout/token 配置，密钥通过 macOS `safeStorage` 加密存储。

### CLI

- HAR inspect、API replay、k6/JMeter/Postman 生成、k6/JMeter 执行、报告读取。
- UI 用例 validate/import/run。
- Java/WAR 分析。
- Asset scan/list/run/history/compare。
- Coverage analyze/list/execute。
- Agent 确定性计划、确认、执行、恢复、取消和分析。
- 不调用模型时核心确定性能力可运行。

## 4. 仅有界面/元数据但能力不完整的功能

- **凭据引用**：资产可保存 `env://`、`keychain://`、`vault://` opaque reference，但 API replay 尚未在执行时解析这些引用或自动注入 Authorization/Cookie。项目配置明确拒绝保存敏感 header，这是安全设计，但也意味着需要认证的真实 API 需要后续安全注入机制。
- **API 数据关联**：`correlations` 已用于 k6/JMeter 生成器，API replay 尚未执行运行时 JSONPath 提取与后续请求替换。
- **前置认证**：尚无登录/Token 获取/刷新流程。
- **覆盖分析**：支持导入 runtime coverage JSON 和候选生成；没有 Java 应用 instrumentation/agent 集成，覆盖率来源需用户提供。
- **WAR 嵌套 JAR**：只清单不解析内部调用链。
- **远程执行**：没有服务端、队列或远程执行器。

## 5. 依赖外部服务/环境的能力

- 真实业务 API/UI/性能测试：需要用户明确授权的目标地址、账号、数据、时间窗和负载上限；当前未提供。
- 外部商用模型：需要用户配置 Base URL、模型名和 API Key；当前未配置，未验证。
- JMeter/k6：本机路径可用，但其他 Mac 需要安装或配置可执行路径。
- Chrome/Playwright：打包 App 可调用本机 Chrome；其他机器需要 Chrome。
- Java runtime coverage：需要目标 Java 应用提供真实覆盖数据。

## 6. 已知故障与安全风险

Baseline 未发现新的 P0。

保留 P1/P2：

- Agent 普通 path 工具允许计划显式选择的绝对路径，尚未实现 allowed input roots。
- 崩溃后原子写 `.tmp` 文件可能残留，尚无启动清理。
- Java 静态解析器不是完整编译器前端。
- WAR 嵌套 JAR 不内调。
- macOS 包未签名/未公证。
- 桌面文件选择人工交互缺少完整 GUI 自动化测试。
- 无权限目录和离线 macOS 权限弹窗未做完整浏览器级测试。

已覆盖的安全能力：

- HAR 输入敏感 header/query/body 脱敏。
- API response preview、断言 expected/actual/error 脱敏。
- UI 输入值报告脱敏。
- 目标与模型 URL 拒绝 credential/query/fragment。
- 项目路径 symlink canonical 校验。
- 模型 API Key 使用 `safeStorage`，安全存储不可用时拒绝保存。
- Agent 工具白名单，无 shell。
- 副作用计划必须人工确认。
- API replay 取消/超时分别记录 `cancelled` / `timeout`。

## 7. 本机启动步骤

### 开发版

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
pnpm install --frozen-lockfile
CI=true pnpm desktop:run
```

### CLI

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
CI=true pnpm cli --help
```

### 打包 App

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
CI=true pnpm desktop:package
open release/mac-arm64/Test\ Agent\ Workbench.app
```

### Smoke

```sh
CI=true pnpm desktop:smoke
CI=true pnpm desktop:smoke-ui
release/mac-arm64/Test\ Agent\ Workbench.app/Contents/MacOS/Test\ Agent\ Workbench --smoke-test
release/mac-arm64/Test\ Agent\ Workbench.app/Contents/MacOS/Test\ Agent\ Workbench --smoke-ui
```

## 8. Baseline 结论

- 本地 Mac MVP 主链路可启动、可打包、可执行真实 HAR/API/UI/k6/JMeter fixture。
- 报告、任务、资产和历史可持久化并在重开后读取。
- 未发现阻止本地试用的 P0。
- 真实业务 API/UI/性能/白盒试点仍未验证，不能把本地 fixture 结果写成真实业务验收。
- 可以进入第八阶段本地 fixture MVP 试点和小范围个人试用；团队分发前应先完成签名、公证和真实业务试点。

## 9. Baseline 后续 P0 修复

Baseline 后复核 CLI 入口时发现：`replay` / `ui` / `engine` 子命令设置 `process.exitCode=1` 后，`main()` 固定返回 0，导致真实测试失败被外层包装器视为成功。

修复：

- `src/cli/index.ts` 保留子命令设置的失败退出码。
- 新增 `tests/integration/cli-exit-status.spec.ts`，验证失败 replay 输出失败报告且 exit code 1。

修复后：

- `CI=true pnpm typecheck`：通过。
- `CI=true pnpm test`：`74 passed / 16 skipped`，exit 0。
- 最终打包 App smoke：通过。
- 最终 ZIP SHA256：`32bba1d366ab58330ab4306aa6df3c11719834386d9ca984fd55f5a1f3fc19dd`。
