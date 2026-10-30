# 第九阶段证据索引

日期：2026-10-29。所有执行结果均为本地自动化测试或本地授权 fixture；未收到真实业务环境，真实业务试点仍为待完成。

## 1. 安全与凭据

测试：

- `tests/unit/target-policy.spec.ts`
- `tests/desktop/credential-service.spec.ts`
- `tests/integration/agent-code-analysis.spec.ts`
- `tests/desktop/temp-cleanup.spec.ts`

结果：

- Agent 未授权路径失败关闭。
- 公网域名解析到 private/link-local 地址被拒绝。
- Bearer/Cookie/Basic/custom header 凭据只保存加密秘密。
- 项目配置只保存 `safe://<id>` 引用。
- 报告和日志不包含凭据或 runtime token。
- 过期 `.test-agent` 原子写临时文件被清理，用户输入保留。

## 2. API 凭据与数据关联

入口：`api/api-correlation-summary.json`

本地 fixture 流程：

1. 安全注入 `X-Tenant-ID`
2. `POST /login` 提取 `accessToken`
3. 后续请求注入 `Authorization: Bearer ${accessToken}`
4. `POST /orders` 提取动态 `id`
5. `GET /orders/${orderId}`
6. HTTP 200 断言

结果：

- task：`task_20261029000126_806b54`
- run：`run_20261029000126_0ba981`
- status：passed
- requests：3/3 passed
- correlations：`accessToken`、`orderId` 均 extracted
- report：`api/phase-9-correlation/output/run_20261029000126_0ba981.json`
- 并发 replay 变量隔离测试通过
- 提取失败与缺失变量分类为 `correlation` 的测试通过

## 3. 桌面打包与 smoke

入口：`desktop/package-smoke.txt`

- 基础 smoke：passed，`TEST_AGENT_DESKTOP_SMOKE=ready`
- 安全存储：available
- 打包 App Playwright：run `ui_20261029000440_1b70f6`，2/2 passed
- ZIP SHA256：`12bee8be6a83d9748b287ae30ef71e6a11dea858a1fee0d0f833507c0a1415aa`
- app.asar SHA256：`1bc53c2a43bc667aeb51bac2875341c78b634d996670b19fe24be1e8140ef389`

## 4. 签名与公证

- 脚本：`/Users/ztl/Downloads/AIProject/test-agent/scripts/sign-notarize-macos.sh`
- 说明：`/Users/ztl/Downloads/AIProject/test-agent/MACOS_RELEASE.md`
- 实测缺少证书环境变量时 exit 2，fail-closed。
- 签名/公证：未验证，未伪造成功记录。

## 5. 真实业务 API

状态：待完成。见 `/Users/ztl/Downloads/AIProject/test-agent/PHASE9_REAL_API_TRIAL.md`。
