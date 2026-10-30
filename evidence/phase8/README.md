# 第八阶段 MVP 试运行证据

日期：2026-10-28。真实业务系统未提供；以下 API/UI/性能/白盒结果均为本地授权 fixture 或真实本地引擎结果，不冒充真实业务验收。

## 1. Baseline

- `../PHASE8_BASELINE.md`
- typecheck：通过，exit 0。
- 全量测试 baseline：`73 passed / 15 skipped`，exit 0。
- P0 修复后全量测试：`74 passed / 16 skipped`，exit 0。
- 桌面打包、基础 smoke、安全存储和打包 App Playwright smoke：通过。

## 1b. 最终打包 Smoke

- `desktop/package-smoke.txt`
- 基础 smoke：passed，安全存储 available。
- 打包 App Playwright：run `ui_20261028062111_9e1e77`，2/2 passed。
- 最终 ZIP SHA256：`32bba1d366ab58330ab4306aa6df3c11719834386d9ca984fd55f5a1f3fc19dd`。

## 2. API MVP 试点

入口：`api/api-trial-summary.json`

- 项目：`api/phase-8-mvp-api-5`
- 请求：3 个，包含 GET/POST 和预期 HTTP 500。
- 断言：状态码、JSONPath、contains。
- 两次真实运行：`run_20261028062515_b7cdf0`、`run_20261028062515_bbf458`
- 每轮 2/3 通过，1 个真实 HTTP 500。
- 报告保留 `error_kind: http` 和断言失败详情。
- 两次运行完成历史比较。
- 关闭并重开 ProjectService 后，2 条任务记录和报告可读取。
- 输入 Authorization/password 和响应 token/password 均未出现在报告或证据中。
- 环境通过非敏感 `X-Test-Environment` header 独立配置。
- 真实业务 API：未验证。

说明：`api` 目录中 `phase-8-mvp-api`、`-2`、`-3` 等前几个目录来自测试断言写法调整过程中的失败测试执行；最终有效摘要指向 `phase-8-mvp-api-5`。这些不是产品执行失败，报告本身当时已正确生成。

## 3. UI 试点

入口：`ui/ui-trial-summary.json`

- 登录、工作区状态切换、动态查询、表单输入、select、提交、断言：`ui_20261028043820_5a93d7`，11/11 passed。
- 下游失败路径：`ui_20261028043827_8ea5b7`，8/8 passed。
- 故意错误断言：`ui_20261028043836_b4e242`，7/8，保留真实失败截图。
- 真实业务 UI、独立 URL 跳转和原生弹窗：未验证。

## 4. 性能试点

入口：`performance/trial-summary.json`

- k6 1.8.2：`engine_20261028062256_197ed2`，3 请求，2 通过，1 个 fixture 预期 500；原始 summary/stdout/stderr 已保存。
- JMeter 5.6.3：`engine_20261028062418_5c5c9f`，3 请求，2 通过，1 个 fixture 预期 500；JTL/JMX/log 已保存。
- JMeter 初次被环境代理转为 502；禁用代理并设置本地 non-proxy 后重跑成功。失败 JTL 保留为 `engine_20261028062333_272f39.proxy-failure.jtl`。
- 对未监听端口的 k6/JMeter 失败采集也已验证。
- CLI 在存在测试失败时返回 exit 1；这验证了第八阶段 P0 修复。
- 真实业务负载：未验证。

## 5. 白盒抽查

入口：`code/spot-check-summary.json` 和 `code/spot-check-summary.md`

- Java 源码分析：`java-source-analysis.json`
- WAR 分析：`java-war-analysis.json`
- 抽查确认端点映射、调用参数、分支、异常和行号证据。
- Java record 解析遗漏、异常消息不完整、branch id 类内唯一、嵌套 JAR 未内调均已记录。
- runtime coverage：`percentage=null`。
- 真实业务源码/WAR：未验证。

## 6. 模型不可用

入口：`model/model-status-summary.json`

- CLI 确定性计划：`model/plan.json`
- plan hash：`b162a2e27dbe0751018605b8854044d59c16aa9d1f42ce0a32ab0ce39cb0ff95`
- `model_status: unavailable`
- 计划校验通过。
- 外部商用模型：未配置，未验证。
