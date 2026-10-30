# Test Agent Workbench MVP 快速开始

适用范围：本机 macOS 个人试点。当前包未签名/未公证；团队分发前请先阅读 `MVP_LIMITATIONS.md`。

## 1. 安装与启动

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
pnpm install --frozen-lockfile

# 开发版桌面应用
CI=true pnpm desktop:run

# 或使用打包 App
CI=true pnpm desktop:package
open release/mac-arm64/Test\ Agent\ Workbench.app
```

首次启动后看到欢迎页，点击 **创建测试项目** 或 **打开已有项目**。

## 2. 创建工作区

1. 点击 `创建测试项目`。
2. 输入项目名称，例如 `orders-local`。
3. 选择一个空目录作为工作区。
4. 项目会创建：

```text
<工作区>/project.json        项目配置
<工作区>/har/                脱敏后的 HAR
<工作区>/scripts/            k6/JMeter 脚本
<工作区>/output/             报告
<工作区>/.test-agent/        任务、资产、分析、UI 用例
```

## 3. 导入 HAR

1. 顶部点击 `导入 HAR`。
2. 选择 `.har` 或 `.json` HAR 文件。
3. 在 `API 实验台` 查看请求方法、URL、header、query 和 body。

导入时会执行：

- 文件大小和请求条数限制。
- Authorization/Cookie/token/password 等敏感值脱敏。
- 只把脱敏后的 HAR 保存到工作区。

原始 HAR 不会被移动或覆盖。

## 4. 配置授权测试环境

在项目总览或 API 实验台展开配置表单：

- Target base URL：例如 `http://127.0.0.1:8089`。
- Allowed origins：必须包含 target origin。
- Allowed paths：可留空；填写后仅允许匹配路径。
- Environment headers：只能保存非敏感 header。
- Assertions：支持 HTTP 状态、JSONPath、contains、耗时。
- Authorization scope：写明授权范围、账号/数据/时间窗。
- 勾选目标与测试范围已获授权。
- Credential reference：可选择已保存的安全凭据。

未配置 target、未勾选授权或 origin 不匹配时，执行会被拒绝。

## 5. 配置凭据和运行时关联

在 `API 实验台` 的 `Credentials` 区域保存 Bearer token、Cookie、Basic Auth 或自定义 Header。保存后获得 `safe://<id>` 引用；秘密值由 macOS 安全存储加密，界面不回显，API 执行时只在主进程内存中注入。

Correlations 支持从响应 JSON 提取本次运行变量，并替换后续 path/body 或注入 Header。示例见 `samples/phase9-correlations.json`：

```json
[
  {
    "sourceIndex": 0,
    "jsonPath": "$.accessToken",
    "variableName": "accessToken",
    "targetIndexes": [],
    "targetHeaders": [
      { "index": 1, "name": "Authorization", "value": "Bearer ${accessToken}" }
    ]
  },
  {
    "sourceIndex": 1,
    "jsonPath": "$.id",
    "variableName": "orderId",
    "targetIndexes": [2]
  }
]
```

CLI 使用 `--correlations <file>` 传入相同配置。报告只记录变量名、来源请求、目标请求和提取状态，不记录变量值。

## 6. 执行 API 回放

1. 进入 `API 实验台`。
2. 检查请求列表和请求详情。
3. 点击 `执行真实回放`。
4. 进入 `运行记录` 查看状态、报告、失败请求、断言和日志。

状态含义：

- `passed`：请求和断言均通过。
- `test_failed`：存在 HTTP 失败或断言失败。
- `timeout`：请求超时。
- `cancelled`：用户取消。
- `failed`：执行器/流程异常。
- `interrupted`：应用退出或进程消失后的恢复状态。

同一项目一次只允许一个运行任务。

## 7. 查看历史和比较

1. 进入 `测试资产`。
2. 选择 `api-imported-har` 或其他资产。
3. 点击执行可重复运行。
4. 查看运行历史。
5. 至少两次运行后点击 `比较最近两次真实运行`。

差异来自真实报告；缺失指标显示为不可用，不会补零。

## 8. 模型配置

进入 `Agent 编排` 的 `模型网关`：

- Provider：OpenAI-compatible / DeepSeek / custom OpenAI-compatible。
- Base URL：外部网关必须 HTTPS；本地回环可用 HTTP。
- Model：供应商提供的模型名。
- Chat path：默认 `/chat/completions`。
- Timeout / Max tokens：按需设置。
- API Key：仅主进程处理，macOS 使用安全存储加密。

点击 `保存模型配置` 和 `测试连接`。模型不可用时会显示安全错误并降级为确定性计划；API/UI/性能执行不依赖模型。

## 9. 常见错误

| 现象 | 处理 |
|---|---|
| `target origin is not whitelisted` | 检查 base URL 与 allowed origins 是否完全一致。 |
| `configure the target base URL` | 先填写 target。 |
| `confirm the authorized test scope` | 填写授权范围并勾选确认。 |
| `sensitive header cannot be persisted` | 不要把 Authorization/Cookie/Token 写入项目配置；改用安全凭据。 |
| `credential not found` | 检查 Credential reference 是否为有效 `safe://<id>`。 |
| `target rejected credentials` | 服务端返回 401/403；检查凭据、账号权限和环境。 |
| `correlation variable is unavailable` | 前置请求失败或 JSONPath 未提取到值。 |
| `Engine missing` | 安装 k6/JMeter 或在配置里选择可执行文件。 |
| Chrome 启动失败 | 安装 Google Chrome，或确认 macOS 权限。 |
| 模型连接失败 | 查看 Agent 页的安全错误；确定性测试功能不受影响。 |
| HTTP 500 | 这是真实服务端失败，不会被视为执行器成功。 |
| 项目切换被拒绝 | 先停止当前任务。 |

## 10. 数据备份与迁移

备份用户选定的工作区目录即可保留：

- 项目配置。
- 脱敏 HAR。
- 脚本。
- 任务状态。
- 资产版本和运行历史。
- API/UI/性能报告。
- 代码与覆盖分析。

模型配置位于 Electron userData：

```text
~/Library/Application Support/test-agent-workbench/model-config.json
```

该文件不保存明文 API Key；密钥由 macOS 安全存储加密绑定本机，不能直接迁移到其他 Mac。新机器需要重新输入密钥。
测试凭据同样绑定本机安全存储；新机器需要重新保存，工作区只迁移 `safe://<id>` 引用。

## 11. 最小验收命令

```sh
CI=true pnpm typecheck
CI=true pnpm test
CI=true pnpm desktop:package
CI=true pnpm desktop:smoke
CI=true pnpm desktop:smoke-ui
```
