# 第十阶段证据索引

日期：2026-10-29。

范围：**本地自动化、本机回环 fixture 和桌面 Smoke。未收到真实业务环境，真实 API 试点未执行。**

## 1. 文件索引

| 文件 | 内容 | 结果 |
|---|---|---|
| `typecheck.txt` | `CI=true pnpm typecheck` 原始输出 | exit 0 |
| `test.txt` | 沙箱内 `CI=true pnpm test` | 85 passed / 20 skipped；跳过因回环绑定受限 |
| `test-local-full.txt` | 沙箱外完整本地 `CI=true pnpm test` | 37/37 文件、105/105 测试通过 |
| `phase9-phase10-local-tests.txt` | phase9/phase10 回环验收原始输出 | 4/4 tests passed |
| `local-readiness-summary.json` | 第十阶段本地回环检查摘要 | passed |
| `local-readiness-report.json` | 本地 correlation 链脱敏报告 | 2/2 requests passed |
| `desktop-smoke.txt` | Electron 基础 Smoke | ready；安全存储 available |
| `desktop-smoke-ui.txt` | Electron + Playwright UI Smoke | ready；2/2 steps passed |
| `typecheck-r2.txt` | 桌面授权门禁与请求选择补充后的 `CI=true pnpm typecheck` | exit 0 |
| `test-local-full-r2.txt` | 桌面授权门禁与请求选择补充后的沙箱外完整测试 | 37/37 文件、107/107 测试通过 |
| `desktop-smoke-r2.txt` | 补充后 Electron 基础 Smoke | ready；安全存储 available |
| `desktop-smoke-ui-r2.txt` | 补充后 Electron + Playwright UI Smoke | ready；2/2 steps passed |
| `typecheck-r3.txt` | 前端交互优化后 `CI=true pnpm typecheck` | exit 0 |
| `test-local-full-r3.txt` | 前端交互优化后沙箱外完整测试 | 37/37 文件、107/107 测试通过 |
| `desktop-smoke-r3.txt` | 前端交互优化后 Electron 基础 Smoke | ready；安全存储 available |
| `desktop-smoke-ui-r3.txt` | 前端交互优化后 Electron + Playwright UI Smoke | ready；2/2 steps passed |

## 1.1 追加验证：桌面授权门禁与请求选择

第十阶段验收记录定稿后，继续落实了 `PHASE10_PLAN.md` 第 6 节的桌面执行入口要求：

- 项目配置新增 `authorization.confirmed` 与 `authorization.scope`；确认授权时必须填写授权范围。
- API 回放、性能、UI 与 Agent 任务启动前统一执行授权门禁；未确认授权一律拒绝。
- API 回放支持按请求 `order` 选择子集执行（桌面请求列表选择入口）。
- 桌面 UI 增加目标授权状态展示与“已确认目标、参数、授权范围和副作用风险”确认交互。

补充验证中发现并修复一处测试契约回归：phase9 测试 fixture 此前用 `any` 绕过类型、只提供 `index` 字段；在运行时索引统一使用 `ParsedHarRequest.order` 后暴露。已改为符合类型契约的 `order` 字段（与 phase10 fixture 和 HAR 解析器一致）。

追加验证结果见上表 `-r2` 文件。真实业务 API 仍为**未执行**。

## 1.2 追加验证：前端 UI 交互优化（2026-10-30）

针对桌面端"界面不友好"的反馈，优化以下交互问题：

- 表单草稿不再因界面刷新丢失：项目配置、模型配置、凭据表单共 33 个输入项标记为持久草稿，重渲染前后自动快照与恢复。
- 重渲染后保持窗口滚动位置、列表滚动位置和输入焦点（含光标位置）。
- 异步操作按钮进入忙碌态（"处理中…" + 加载指示），同动作防重复触发。
- 项目配置/模型配置/凭据表单支持回车直接保存。
- 键盘焦点可见性（focus-visible 描边）、Toast 可访问性（status/alert 语义）、系统"减弱动态效果"偏好支持。
- 保存/删除/切换凭据等会重置表单的动作显式跳过草稿恢复，避免复活已提交的密钥或旧表单值。

验证结果见上表 `-r3` 文件。真实业务 API 仍为**未执行**。

## 2. 本地运行 ID

来自 `local-readiness-summary.json`：

- correlation：`run_20261029015530_07be6b`
- 401 分类：`run_20261029015530_5d9d1c`
- 500 分类：`run_20261029015530_29fae0`
- 无效响应分类：`run_20261029015530_1014e0`
- `/apix` 边界阻止：`run_20261029015530_92d5eb`
- `/api/orders` 边界放行：`run_20261029015530_8e0cd0`

桌面 UI Smoke：

- task：`task_20261029015519_493468`
- run：`ui_20261029015519_68ed16`
- status：passed

追加验证（2026-10-30）桌面 UI Smoke：

- task：`task_20261030044100_979438`
- run：`ui_20261030044100_f03da0`
- status：passed

前端交互优化后（2026-10-30）桌面 UI Smoke：

- task：`task_20261030045831_1b5d4d`
- run：`ui_20261030045831_4230bf`
- status：passed

以上均为本机回环 fixture 结果，不是真实业务 Run ID。

## 3. 第十阶段本地检查覆盖

- 凭据 Header 注入。
- 动态值注入 Path、Body 和 Header。
- HTTP 200 成功链与业务 JSON 断言。
- 401 分类为 `auth`。
- 500 分类为 `http`。
- 无效 JSON 断言分类为 `assertion`。
- `/api/**` 不匹配 `/apix`，边界请求未到达 fixture。
- 报告不含运行时值和凭据值。
- 断言证据中的 correlation 值同样脱敏。
- 第九阶段 correlation、超时、取消、任务状态和临时文件测试回归通过。

## 4. 脱敏检查

`local-readiness-summary.json` 和 `local-readiness-report.json` 已扫描测试运行时随机值，未发现原值。

本轮证据未写入真实凭据、真实 Token、真实 Cookie、密码或 API Key。第十阶段新增测试使用运行时随机生成的非认证 fixture 值。

## 5. 桌面 Smoke 说明

- 基础 Smoke：`TEST_AGENT_DESKTOP_SMOKE=ready`，`TEST_AGENT_SECURE_STORAGE=available`。
- UI Smoke：Electron + Playwright 成功执行导航和文本断言，2/2 steps passed。
- 最终一次 UI Smoke 返回 ready 且任务 passed，证据输出中无影响结果的警告。

## 6. 真实业务 API

状态：**未执行。**

当前没有真实环境 Run ID、请求统计、真实断言或清理记录。进入真实试点所需信息见 `PHASE10_REAL_API_TRIAL.md`。

本地 Mock、fixture 或回环结果不得作为真实业务 API 验收证据。
