# 第七阶段真实项目试点操作指南

本指南用于授权环境中的试点。当前仓库只自带自建 Java fixture；未收到用户提供的真实业务仓库、WAR 或目标系统授权，因此真实业务验证状态是“未验证”，不能用 fixture 结果替代。

## 1. Java 源码项目试点

```sh
CI=true pnpm cli code analyze /path/to/java/project \
  --output /path/to/workbench/java-analysis.json
```

检查输出中的：

- `structure.source_files / packages / build_files / frameworks`
- `classes[].methods[]`：签名、参数、行号。
- `endpoints[]`：HTTP 方法、路径、Controller、实现方法、文件和行号。
- `calls[]`：caller、target、行号、`resolved`、`arguments`（源码参数表达式证据）。
- `branches[]` / `exceptions[]`：条件、异常和行号。
- `uncertainties[]`：Reflection、动态代理、不能解析的语法等限制。
- `coverage.measured`：没有 runtime 输入时必须为 `false`。

自建 fixture 复现：

```sh
CI=true pnpm cli code analyze fixtures/java-project \
  --output evidence/phase7/code/java-source-analysis.json
```

## 2. WAR 试点

```sh
CI=true pnpm cli code analyze /path/to/application.war \
  --output /path/to/workbench/war-analysis.json
```

能力与限制：

- 先做归档条目数、展开大小、路径安全和 CRC 校验。
- 直接解析 `WEB-INF/classes/**/*.class` 的常量池、方法、字节码分支、异常表、调用和参数 descriptor。
- 嵌套 JAR 只安全清单，不宣称已解析内部调用链。
- 不反编译为源码，不执行 WAR 中的应用代码。
- 无源码时不推断 Spring path；endpoint 数量可以为 0。
- 字节码 descriptor 只证明参数类型，不证明运行时实参值。

自建 fixture 复现：

```sh
CI=true pnpm cli code analyze fixtures/java-war-fixture/demo.war \
  --output evidence/phase7/code/java-war-analysis.json
```

## 3. 建立测试项目和资产

桌面端：

1. 创建或打开工作区。
2. 导入 HAR；敏感 header/query/body 会脱敏后进入项目。
3. 配置 target base URL、allowed origins、授权范围并勾选授权确认。
4. 在 Code & Coverage 页选择 Java 源码目录或 WAR。
5. 执行代码分析、覆盖分析；没有 runtime coverage 时百分比保持 `null`。
6. 对候选用例执行前检查目标、参数、证据和风险。

CLI 示例：

```sh
CI=true pnpm cli asset scan --project /path/to/workbench
CI=true pnpm cli asset run <asset-id> --project /path/to/workbench
CI=true pnpm cli asset history <asset-id> --project /path/to/workbench
CI=true pnpm cli asset compare <asset-id> --project /path/to/workbench
CI=true pnpm cli coverage analyze <java-analysis.json> --project /path/to/workbench
CI=true pnpm cli coverage execute <coverage-id> <candidate-id> --project /path/to/workbench
```

## 4. 模型网关配置与安全

桌面 Agent 页可在未创建项目时配置模型：

- Provider：OpenAI-compatible / DeepSeek / custom OpenAI-compatible。
- Base URL：外部网关必须 HTTPS；仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。
- Model、chat path、timeout、max tokens。
- API Key：仅在 Electron 主进程处理；macOS 使用 `safeStorage` 加密后落盘。
- Renderer 只收到 `hasApiKey` 和配置状态，不收到密钥。
- 安全存储不可用时，应用拒绝保存 API Key，不会退化为明文文件。
- 配置文件和模型错误不记录 Authorization、Cookie、password、token、api key 或 Bearer 值。
- 模型输出必须通过 `test-agent.plan/v1` schema、工具白名单和参数校验。
- 模型只生成候选计划；`api.replay`、`engine.run.*` 等副作用步骤必须由用户显式确认后才会执行。
- 模型超时、401/403、404、429、5xx、非法 JSON、空输出或截断都会给出安全错误，并降级为确定性计划。

本机验证方式：

- 可用路径：`tests/integration/phase7-model-gateway.spec.ts` 使用本地 OpenAI-compatible HTTP fixture。
- 不可用路径：同一测试验证非法 JSON和无模型降级。
- 外部商用模型：需要用户在桌面端配置真实 Base URL、模型名和密钥后点击“测试连接”；当前环境未配置，标记未验证。

## 5. 端到端试点检查单

每次真实业务试点前确认：

1. 目标系统、账号、数据、时间窗和并发上限已获书面授权。
2. 只允许声明过的 origins 和 paths。
3. POST/PUT/PATCH/DELETE、性能测试和真实业务 UI 操作均已人工确认。
4. 有回滚/清理方案和联系人。
5. 失败结果不得改写为通过；保留 HTTP 状态、断言、日志、截图、脚本和报告。
6. 未提供 runtime coverage 时，不汇报覆盖率百分比或覆盖率提升。
7. 模型推断必须与真实报告事实区分。

本地可重复闭环：

```sh
PHASE7_EVIDENCE_DIR=/Users/ztl/Downloads/AIProject/test-agent/evidence/phase7/e2e \
CI=true pnpm vitest run tests/integration/phase7-end-to-end.spec.ts
```

该命令需要本地 bind/connect、Playwright Chrome 和 k6；沙箱内会跳过。

## 6. 发布前检查

当前 App 未签名、未公证。发布前需要：

- Developer ID Application 证书和 Team ID。
- hardened runtime、最小 entitlements 和外层 DMG/ZIP 策略。
- notarytool 凭据与公证记录。
- 最终 `codesign --verify --deep --strict --verbose=2`。
- `spctl --assess --type execute`。
- 在干净 macOS arm64 机器验证 Chrome、k6、JMeter 发现和项目目录权限。
