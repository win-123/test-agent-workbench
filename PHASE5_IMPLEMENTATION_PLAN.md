# 第五阶段实施计划：Test Agent 桌面工作台

日期：2026-10-28

## 1. 前置复核

- 第三、四阶段真实执行闭环证据已复核；`PHASE4_ACCEPTANCE.md` 记录 40 passed / 8 skipped。
- Harness 固定于 `1f81c047fc48fa190a683e469daa699857e9afe8`，核心源码未修改。
- 当前测试核心为 Node.js 24 + TypeScript，CLI 入口为 `src/cli/bin.ts`。
- 项目根目录不是 Git 仓库；`deepseek-harness/` 是独立 Git 仓库，只有加载插件用的未跟踪目录。

## 2. 技术选型

选择 Electron，原因如下：

- 现有测试核心、CLI 和 Harness 均为 Node/TypeScript，Electron 主进程可直接复用现有 ESM 模块。
- 本机已缓存 Electron 44.7.x macOS arm64 运行时；实际锁定并打包 44.7.0，Harness 依赖中有 electron-builder 26.17.0。
- Electron 对本地子进程、AbortSignal、文件选择和退出收尾支持成熟。
- Tauri 需要 Rust/Cargo，本机未安装，会引入新的工具链和跨语言边界。

### 进程与安全边界

```text
Renderer (sandbox, contextIsolation, no Node)
        |
        | narrow typed IPC via preload
        v
Electron main process
  desktop application services
        |
        +-- existing HAR parser / replay / generators
        +-- existing runEngine / report / AgentOrchestrator
        +-- local project store and task record store
```

渲染进程不解析 HAR、不执行测试、不计算报告指标。主进程只调用已存在的测试核心。

## 3. 最小实施顺序

1. 构建 Electron 主进程/preload/renderer 最小原型并验证窗口启动。
2. 实现项目创建、打开、切换、HAR 导入及脱敏。
3. 接入 API replay、断言、关联和环境配置。
4. 接入 k6/JMeter 检测、脚本生成、真实执行、取消和日志。
5. 接入统一任务历史、真实报告和当前执行状态刷新。
6. 接入确定性 Agent 计划、确认、工具调用、进度与失败分析。
7. 增加项目、任务、IPC 安全、脱敏、取消、超时和异常退出测试。
8. 打包 macOS arm64 应用并启动打包产物验收。

## 4. 拟修改文件

### 桌面应用

- `desktop/main.ts`
- `desktop/preload.ts`
- `desktop/renderer/index.html`
- `desktop/renderer/app.ts`
- `desktop/renderer/styles.css`
- `desktop/electron-builder.mjs`

### 应用服务

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
- `scripts/package-desktop.mjs`
- `tests/desktop/*.spec.ts`
- `package.json`
- `.gitignore`
- `README.md`
- `PHASE5_ACCEPTANCE.md`

不会修改 Harness 核心源码，也不会重写现有 HAR、回放、生成器、执行和报告模块。
