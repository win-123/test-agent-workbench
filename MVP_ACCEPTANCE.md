# 第八阶段 MVP 验收记录

验收日期：2026-10-28

## 结论

- **本地 Mac 个人初步试用：通过。**
- **真实业务 MVP 验收：未完成。**未提供授权业务 API/UI/性能目标、账号、数据、负载上限、真实 Java/WAR 样本或外部模型网关。
- **团队试用：暂不建议直接开始。**建议先完成一轮真实授权 API 回调、凭据注入方案和 macOS 签名公证。
- 当前无剩余 MVP P0。第八阶段发现并修复 CLI 失败退出码被覆盖的 P0。

## 1. Baseline 与 P0

| 项 | 状态 | 证据 |
|---|---|---|
| 第七阶段材料存在 | 通过 | `PHASE8_BASELINE.md` |
| typecheck | 通过 | exit 0 |
| 全量测试 baseline | 通过 | `73 passed / 15 skipped` |
| 桌面打包 | 通过 | exit 0 |
| 打包 App基础 smoke | 通过 | `TEST_AGENT_DESKTOP_SMOKE=ready` |
| 安全存储 | 通过 | `TEST_AGENT_SECURE_STORAGE=available` |
| 打包 App Playwright | 通过 | baseline run `ui_20261028043408_a80f41` |
| CLI 失败退出码 P0 | 已修复 | `tests/integration/cli-exit-status.spec.ts` |

P0 证据：`src/cli/index.ts` 原来在子命令设置 `process.exitCode=1` 后固定返回 0，导致失败 replay/UI/engine 被 CLI 包装器标记为成功。现已保留失败码，并验证失败 replay exit 1。

## 2. MVP 最低门槛

| 门槛 | 状态 | 证据 |
|---|---|---|
| 本地启动和退出稳定 | 通过 | 开发版/打包 App smoke |
| 工作区创建、打开、持久化 | 通过 | project service 测试和 API 试点 |
| HAR/API 主链路可重复运行 | 通过 | `evidence/phase8/api/api-trial-summary.json` |
| 失败原因与证据可查看 | 通过 | HTTP 500、断言失败、日志、报告、截图、JTL |
| 重启后资产/历史/报告恢复 | 通过 | API 试点 persistence check |
| 凭据脱敏 | 通过 | 输入/响应敏感值扫描未见明文 |
| 工作区路径安全 | 通过 | symlink/path traversal/security 测试 |
| 目标环境确认 | 通过 | target、allowed origins、authorization scope 必填/确认 |
| 模型不可用时确定性能力可用 | 通过 | `evidence/phase8/model/model-status-summary.json` |
| 自动化测试 | 通过 | `74 passed / 16 skipped` |
| 打包与 smoke | 通过 | 最终 App 基础/Playwright smoke |
| 未验证能力标注 | 通过 | 本文件与 `MVP_LIMITATIONS.md` |

## 3. 本地 API 试点

状态：通过（本地 fixture）。

- 3 请求：GET health、POST echo、GET fail。
- 2 通过，1 个真实 HTTP 500。
- 状态码、JSONPath、contains 断言生效。
- 目标环境与非敏感环境 header 独立配置。
- 重复执行、历史比较、重启读取报告通过。
- 输入 Authorization/password 与响应 token/password 均脱敏。
- 真实业务 API：未验证。
- 凭据注入、API 运行时关联、前置认证：当前版本限制，见 `MVP_LIMITATIONS.md`。

## 4. UI 试点

状态：通过（本地 fixture）。

- 真实 Chrome/Playwright。
- 登录状态切换、动态查询、表单、select、提交、错误路径、断言、失败截图。
- 真实业务 UI、独立 URL 跳转、原生弹窗：未验证。

## 5. 性能试点

状态：通过（本地 fixture + 真实 k6/JMeter 进程）。

- k6 1.8.2：3 请求，2 通过，1 预期 500。
- JMeter 5.6.3：3 请求，2 通过，1 预期 500。
- 脚本生成成功且真实引擎执行成功，两者已区分。
- 原始 k6 JSON、JTL、JMX、stdout/stderr/log 已保存。
- 环境代理导致的 JMeter 502 已记录并禁用代理重跑。
- 真实业务负载：未验证。

## 6. 白盒抽查

状态：通过（自建源码/WAR fixture）。

- 端点映射、调用参数、分支、异常、行号抽查一致。
- Reflection 限制明确。
- WAR nested JAR 未解析明确。
- runtime coverage 无输入，`percentage=null`。
- 真实业务源码/WAR：未验证。

## 7. 模型

- 模型不可用确定性路径：通过。
- 本地 OpenAI-compatible HTTP fixture：第七阶段已验证。
- 外部商用模型：本阶段未配置，未验证。
- 模型输出仍受 schema/工具白名单/人工确认约束。

## 8. 最终命令与结果

```sh
CI=true pnpm typecheck
CI=true pnpm test
CI=true pnpm desktop:package
CI=true pnpm desktop:smoke
CI=true pnpm desktop:smoke-ui
PHASE8_EVIDENCE_DIR=/Users/ztl/Downloads/AIProject/test-agent/evidence/phase8/api \
CI=true pnpm vitest run tests/integration/phase8-mvp-api.spec.ts
```

结果：

- typecheck：exit 0。
- 全量测试：24 个文件通过、8 个文件沙箱网络跳过；`74 passed / 16 skipped`，exit 0。
- phase8 API 试点：1 个测试通过，exit 0。
- desktop package：exit 0。
- 打包 App基础 smoke：exit 0，`TEST_AGENT_DESKTOP_SMOKE=ready`，安全存储 available。
- 打包 App Playwright：exit 0，run `ui_20261028062111_9e1e77`，2/2 passed。

最终产物：

- App：`release/mac-arm64/Test Agent Workbench.app`
- ZIP：`release/Test Agent Workbench-0.1.0-arm64-mac.zip`
- ZIP SHA256：`32bba1d366ab58330ab4306aa6df3c11719834386d9ca984fd55f5a1f3fc19dd`
- app.asar SHA256：`aa5ff90b54a63459e4fe9f0b261a98e9bce5b4202fa79748c1847b790f268df5`

## 9. 剩余问题与优先级

P1：

1. 安全凭据注入：解析 `env://`、`keychain://`、`vault://` 引用，支持登录/token 获取，不落盘明文。
2. API replay 运行时 correlations。
3. Agent allowed input roots。
4. 崩溃 `.tmp` 清理。
5. macOS 签名与公证。

P2：

1. WAR 嵌套 JAR 清单/引用分析。
2. Java parser 增强，覆盖 record/Lombok/复杂泛型。
3. 文件选择与权限弹窗的完整 GUI 自动化。
4. 远程执行/团队协作服务端。

## 10. 下一步建议

1. 先由本机使用者进行小范围个人试点。
2. 提供一个非生产授权 API 环境和测试账号，完成真实业务 API 回归。
3. 实现最小安全凭据注入后再试真实需认证系统。
4. 完成 Developer ID 签名和 notarization 后，再考虑团队试用。
