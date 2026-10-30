# 第十阶段本地准备验收记录

验收日期：2026-10-29

结论：

- 第九阶段安全边界回归：通过。
- 第十阶段本地准备与本地回环验收：通过。
- 安全凭据、动态关联、错误分类、报告脱敏和桌面 Smoke：通过本地自动化验证。
- 真实授权业务 API：**未执行，待用户提供环境与授权。**
- 真实模型推理：**未执行，不得作为本阶段验收结论。**

## 1. 实际修改

### 安全与回放

- `src/api/replay.ts`
  - 修复 `/api/**` 错误放行 `/apix` 的路径白名单边界。
  - 对本次运行已知凭据值和 correlation 值做完整值脱敏，覆盖 Path、响应预览、错误和 correlation 诊断。
  - 断言期望值、实际值和错误同样纳入完整值脱敏。
  - 新增 `assertion` 错误分类。

### 测试

- `tests/integration/phase10-local-readiness.spec.ts`
  - 本地回环验证凭据 Header 注入。
  - 验证动态值注入 Path、Body 和 Header。
  - 验证认证失败、服务端失败和无效响应分类。
  - 验证路径白名单前缀边界。
  - 验证报告不包含运行时值和凭据值。

### 文档与证据

- `PHASE10_PLAN.md`
- `PHASE10_ACCEPTANCE.md`
- `PHASE10_REAL_API_TRIAL.md`
- `evidence/phase10/`

未修改 DeepSeek Harness 固定 checkout 源码，未访问真实业务系统。

## 2. 本地验证结果

执行环境：

- macOS arm64。
- Node `v24.22.0`。
- pnpm `11.25.0`。
- 完整测试在沙箱外运行，仅使用本机回环 fixture 和本机 Chrome。

结果：

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| Typecheck | `CI=true pnpm typecheck` | exit 0 | `evidence/phase10/typecheck.txt` |
| 沙箱内全量测试 | `CI=true pnpm test` | 85 passed / 20 skipped；跳过均为禁止回环绑定 | `evidence/phase10/test.txt` |
| 完整本地测试 | `CI=true pnpm test` | 37/37 文件、105/105 测试通过 | `evidence/phase10/test-local-full.txt` |
| 第九阶段本地关联回归 | `pnpm vitest run tests/integration/phase9-api-correlation.spec.ts` | 3/3 passed | `evidence/phase10/phase9-phase10-local-tests.txt` |
| 第十阶段本地就绪验收 | `pnpm vitest run tests/integration/phase10-local-readiness.spec.ts` | 1/1 passed | `evidence/phase10/local-readiness-summary.json` |
| 桌面基础 Smoke | `CI=true pnpm desktop:smoke` | `TEST_AGENT_DESKTOP_SMOKE=ready`；安全存储 available | `evidence/phase10/desktop-smoke.txt` |
| 桌面 Playwright Smoke | `CI=true pnpm desktop:smoke-ui` | ready，2/2 steps passed | `evidence/phase10/desktop-smoke-ui.txt` |

本地实际 Run ID：

- 完整 correlation 链：`run_20261029015530_07be6b`
- 认证失败分类：`run_20261029015530_5d9d1c`
- 服务端失败分类：`run_20261029015530_29fae0`
- 无效响应断言分类：`run_20261029015530_1014e0`
- 路径边界阻止：`run_20261029015530_92d5eb`
- 路径边界放行：`run_20261029015530_8e0cd0`
- 桌面 UI Smoke：`ui_20261029015519_68ed16`

以上 Run ID 均来自本地回环 fixture，不是真实业务环境结果。

## 2.1 追加交付：桌面授权门禁与请求选择（2026-10-30）

第十阶段本地验收定稿后，为满足 `PHASE10_PLAN.md` 第 6 节“桌面端为主入口”的执行要求，补充落地：

### 实际修改

- `src/desktop/types.ts`、`src/desktop/project-service.ts`
  - 项目配置新增 `authorization`（`confirmed`、`scope`）。
  - 确认授权时强制填写授权范围；默认创建项目不确认授权。
- `src/desktop/task-service.ts`
  - API 回放、性能、UI、Agent 执行前统一调用授权门禁；未确认授权直接拒绝。
  - 新增按请求 `order` 选择子集回放入口，选择范围受上限约束。
- `desktop/main.ts`、`desktop/preload.ts`、`desktop/renderer/app.ts`
  - 桌面 UI 展示授权状态、授权有效期输入与确认交互；未确认授权时禁止启动测试。
- `tests/desktop/project-service.spec.ts`、`tests/desktop/task-service.spec.ts`
  - 覆盖授权配置校验、未授权拒绝执行与请求选择。
- `tests/integration/phase9-api-correlation.spec.ts`
  - 修复测试 fixture 契约回归：改为提供 `ParsedHarRequest.order`（原先以 `any` 绕过类型只提供 `index`）。生产 HAR 解析器始终输出 `order`，真实回放链路不受该测试问题影响。

### 追加验证

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| Typecheck | `CI=true pnpm typecheck` | exit 0 | `evidence/phase10/typecheck-r2.txt` |
| 完整本地测试 | `CI=true pnpm test` | 37/37 文件、107/107 测试通过 | `evidence/phase10/test-local-full-r2.txt` |
| 桌面基础 Smoke | `CI=true pnpm desktop:smoke` | ready；安全存储 available | `evidence/phase10/desktop-smoke-r2.txt` |
| 桌面 Playwright Smoke | `CI=true pnpm desktop:smoke-ui` | ready；2/2 steps passed（run `ui_20261030044100_f03da0`） | `evidence/phase10/desktop-smoke-ui-r2.txt` |

### 影响结论

- 第十阶段“以桌面端为真实授权 API 试点入口”的准备条件进一步补齐：未确认授权的任务在服务层被统一拒绝，请求子集选择可用于最小只读试点。
- 真实业务 API 试点状态不变：**未执行，仍待用户提供环境与授权。**
- 真实模型推理状态不变：**未执行。**

## 2.2 追加交付：前端 UI 交互优化（2026-10-30）

根据"界面不友好"的使用反馈，对桌面端前端做针对性交互修复，不改变任何服务层安全边界：

### 实际修改

- `desktop/renderer/app.ts`
  - 重渲染前后快照/恢复表单草稿：项目配置、模型配置、凭据表单 33 个输入项不再因轮询、勾选请求、切换选择等界面刷新而丢失未保存内容。
  - 重渲染保持窗口与 `.scroll-list` 滚动位置、输入焦点与光标位置；移除原先只针对请求过滤框的焦点补丁。
  - 异步按钮忙碌态（禁用 + "处理中…" + 加载指示），同一动作防重复触发。
  - 配置/模型/凭据表单支持回车保存。
  - 保存、删除、切换凭据等会重置表单的动作显式跳过草稿恢复，避免复活已提交密钥或旧值。
  - Toast 增加 `status`/`alert` 语义角色。
- `desktop/renderer/styles.css`
  - 键盘焦点 `focus-visible` 描边。
  - 按钮忙碌态样式与加载动画。
  - `prefers-reduced-motion` 减弱动效支持。

### 追加验证

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| Typecheck | `CI=true pnpm typecheck` | exit 0 | `evidence/phase10/typecheck-r3.txt` |
| 完整本地测试 | `CI=true pnpm test` | 37/37 文件、107/107 测试通过 | `evidence/phase10/test-local-full-r3.txt` |
| 桌面基础 Smoke | `CI=true pnpm desktop:smoke` | ready；安全存储 available | `evidence/phase10/desktop-smoke-r3.txt` |
| 桌面 Playwright Smoke | `CI=true pnpm desktop:smoke-ui` | ready；2/2 steps passed（run `ui_20261030045831_4230bf`） | `evidence/phase10/desktop-smoke-ui-r3.txt` |

### 影响结论

- 前端仅改进交互层；授权门禁、凭据安全、目标白名单与报告脱敏逻辑未改动。
- 真实业务 API 试点状态不变：**未执行，仍待用户提供环境与授权。**

## 2.3 追加交付：桌面启动入口与双平台分发产物（2026-10-30）

### 启动入口与产物

- 开发入口：`pnpm desktop:run`（源码 `desktop/main.ts`，构建产物 `dist/desktop/main.cjs`）。
- macOS：`release/Test Agent Workbench-0.1.0-arm64.dmg`（141 MB，含 `.app` 与 Applications 快捷方式）；另有 `.app` 目录与 zip。
- Windows：`release/Test Agent Workbench-0.1.0-win-x64-portable.zip`（155 MB，解压后运行 `Test Agent Workbench.exe`，便携版）。
- 详细说明与 SHA256 见 `RELEASE.md`。

### 构建方式

- `pnpm desktop:package`：electron-builder 产出 arm64 `.app`，再用系统 `hdiutil` 生成 DMG（electron-builder 自带 dmgbuild 在本机静默挂死，故改用确定性方案）。
- `pnpm desktop:package:win`：下载 Electron win32-x64 运行时（npmmirror 优先，已缓存至本机），组装 `resources/app` 后重命名 `electron.exe` 并用 `zip` 打包（无 `__MACOSX` 残留）。

### 验证结果

| 检查 | 结果 |
|---|---|
| DMG 挂载/卸载 | 通过；包含 `.app` 与 `/Applications` 符号链接 |
| 打包后 `.app` `--smoke-test` | `TEST_AGENT_DESKTOP_SMOKE=ready`；安全存储 available |
| Windows zip 结构 | 含 exe、`resources/app/dist/desktop/main.cjs`、`package.json`、playwright 依赖；无 `__MACOSX` |

### 限制（不得宣称通过）

- Windows exe **未在真实 Windows 机器上运行验证**，仅结构校验。
- 两平台产物均**未签名**：macOS 首次打开需手动允许；Windows 可能触发 SmartScreen 提示。
- Windows 为便携版，非 NSIS 安装器；生成安装版需 Windows 机器或 Wine（当前无）。
- macOS 正式签名/公证仍见 `MACOS_RELEASE.md`，当前未配置证书。

## 3. 本地准备验收矩阵

| 要求 | 状态 | 证据/说明 |
|---|---|---|
| 第九阶段关键测试仍通过 | 通过 | 首轮完整本地测试 105/105；追加验证 107/107 |
| 试点前置条件清单 | 通过 | `PHASE10_PLAN.md` |
| 用例、授权和回滚要求明确 | 通过 | `PHASE10_PLAN.md`、`PHASE10_REAL_API_TRIAL.md` |
| 凭据不以明文进入项目/报告 | 通过本地 fixture | 安全凭据测试、phase10 报告扫描 |
| 未提供授权环境时不发真实请求 | 通过 | 本轮无外部请求 |
| 文档区分本地与真实环境 | 通过 | 本文件、试点记录和证据索引 |
| 认证成功/失败分类 | 通过本地 fixture | phase9 成功链；phase10 401 |
| Path/Body/Header 动态注入 | 通过本地 fixture | phase10 |
| HTTP/业务断言 | 通过本地 fixture | phase9、phase10 |
| 无效响应与服务端错误 | 通过本地 fixture | phase10 `assertion`、`http` |
| 并发变量隔离 | 通过本地 fixture | phase9 |
| 日志与报告脱敏 | 通过本地 fixture | phase9 秘密扫描、phase10 报告扫描 |
| 失败状态与诊断留存 | 通过本地自动化 | `task-lifecycle`、`temp-cleanup`、phase10 |
| 桌面基础/UI Smoke | 通过 | phase10 证据 |

## 4. 真实环境验收矩阵

| 要求 | 状态 |
|---|---|
| 认证及凭据注入 | 未执行 |
| 请求执行和业务断言 | 未执行 |
| 动态数据关联 | 未执行 |
| 认证失败和服务端错误分类 | 未执行 |
| 报告和日志脱敏检查 | 未执行 |
| 测试数据清理或保留说明 | 未执行 |
| 失败、跳过和未覆盖项记录 | 未执行 |

真实环境没有任何 Run ID，当前文件不代表真实 API 通过。

## 5. 安全结论

本轮修复了两个影响真实试点的安全/证据问题：

1. Path 子树白名单不再允许相似前缀逃逸。
2. 运行时凭据和 correlation 值不再通过响应回显或 Path 进入脱敏报告。

保留风险：

- DNS 检查与 `fetch` 实际解析仍有时间差。
- 真实 API 可能返回未知字段中的敏感值；当前脱敏覆盖已知凭据值、已提取 correlation 值及常见敏感字段名称，不能证明任意未知业务语义已完全识别。
- CLI 固定白名单和无安全凭据流程不适合作为真实授权 API 试点入口。
- macOS 包签名/公证仍未验证。

## 6. 当前门槛判断

技术准备：**具备进入受控真实只读试点的条件（含桌面授权门禁与最小请求选择）。**

真实执行：**不具备，缺少用户环境、授权、凭据引用、请求上限、数据清理和回滚确认。**

在用户补齐 `PHASE10_REAL_API_TRIAL.md` 所需信息前，阶段状态保持“本地准备通过，真实试点待执行”。
