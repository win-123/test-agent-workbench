# 第四阶段真实执行证据

本目录只保存 2026-10-28 对本地 `127.0.0.1:8089` fixture 执行产生的真实报告和原始证据，不是模拟数据。

## k6

任务：`phase4-e2e-k6-20261028`

统一报告运行 ID：`engine_20261028001448_phase4-e2e-k_engine-k6`

- 引擎：k6 `v1.8.2`
- 退出码：`0`
- 请求：3
- 通过：2
- 失败：1
- HTTP：`/api/health?verbose=true` 200、`/api/echo` 200、`/api/fail` 500
- 证据：`k6/report.json`、`k6/raw-result.json`、stdout/stderr、API replay 报告和状态摘要

## JMeter

任务：`phase4-e2e-jmeter-20261028`

统一报告运行 ID：`engine_20261028001613_phase4-e2e-j_engine-jmeter`

- 引擎：JMeter `5.6.3`
- 退出码：`0`
- 请求：3
- 通过：2
- 失败：1
- HTTP：`/api/health?verbose=true` 200、`/api/echo` 200、`/api/fail` 500
- 证据：`jmeter/report.json`、`jmeter/raw-result.jtl`、stdout/stderr、API replay 报告和状态摘要

`state-summary.json` 由对应任务的真实 `state.json` 投影得到，保留计划、步骤、工具调用记录、运行 ID、artifact 路径和失败分析，不保留确认 token。
