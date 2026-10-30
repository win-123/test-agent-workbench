# 第六阶段真实验收证据

日期：2026-10-28。以下均为本地 fixture、真实 Playwright、真实 k6/JMeter 或真实文件解析结果；没有用模拟报告替代执行结果。

## UI 自动化

| 场景 | 运行 ID | 结果 | 证据 |
|---|---|---|---|
| CLI 登录 / 查询 / 提交 | `ui_20261028005552_958255` | passed，11/11 | `ui/ui_20261028005552_958255.report.json` |
| CLI 下游失败处理 | `ui_20261028005556_410565` | passed，8/8 | `ui/ui_20261028005556_410565.report.json` |
| CLI 故意错误断言 | `ui_20261028005559_a967c0` | failed，7/8，1 张 PNG | `ui/ui_20261028005559_a967c0.report.json` |
| 桌面应用服务链路 | `ui_20261028024103_ee9cdb` | passed，11/11 | `ui-desktop-summary.json` |

失败截图：`ui/ui/ui_20261028005559_a967c0/failure-wrong-expectation.png`。

## 无 AI 性能回归

| 引擎 | 运行 ID | 真实结果 | 证据 |
|---|---|---|---|
| k6 1.8.2 | `engine_20261028005628_e65378` | 3 请求，2 通过，1 预期失败 | `engines/engine_20261028005628_e65378.json`、`.k6.json` |
| JMeter 5.6.3 | `engine_20261028005633_bd67de` | 3 请求，2 通过，1 预期失败 | `engines/engine_20261028005633_bd67de.json`、`.jmeter.jtl` |

原始脚本、stdout/stderr、JMeter log 均在 `engines/`。

## Java 与 WAR

- 源码：`code/java-source-analysis.json`，4 个源码文件/类，2 个 Spring endpoint，5 个静态分支，3 个异常路径，3 个不确定性，未测量覆盖率。
- WAR：`code/java-war-analysis.json`，安全清单 3 项，1 个 class，1 个字节码分支，1 个嵌套 JAR 未内省，未推断 endpoint，未测量覆盖率。

## 覆盖与候选执行

- 覆盖分析：`coverage-summary.json`
- 通过执行：run `run_20261028010518_32bf64`，GET `/api/orders/ORD-1001` HTTP 200。
- 失败诊断：run `run_20261028010424_fa8743`，复用旧 8089 fixture 时得到 HTTP 404；该失败保留为真实证据，未改写为通过。
- 未提供 runtime coverage，因此 `percentage: null`，候选覆盖断言为 `not_measured`。

## 统一资产重复执行与比较

`asset-repeat-comparison.json` 记录同一 HAR 资产两次真实执行：

- `run_20261028010722_571ec5`：2/2 通过
- `run_20261028010722_6bfbc0`：2/2 通过
- 比较报告保留真实耗时差异，缺失指标显示 `null`，不伪造为 0。

## Agent 白盒分析工具

`agent-code/summary.json`：

- task `agent_phase6_java_analysis`
- 工具 `code.analyze.java`
- 状态 `succeeded`
- 无副作用
- 生成确定性 Java 分析 artifact，并列出事实、推断与待验证假设。
