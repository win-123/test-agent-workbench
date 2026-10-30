# macOS 签名与公证发布说明

当前环境没有 Developer ID 证书和 notarytool 凭据，因此本阶段只完成脚本与配置准备，不宣称签名或公证成功。

## 1. 前置条件

- Apple Developer Program 账号
- `Developer ID Application` 证书
- Team ID
- `xcrun notarytool store-credentials TEST_AGENT_NOTARY_PROFILE` 已完成
- Xcode Command Line Tools

## 2. 环境变量

```sh
export TEST_AGENT_MACOS_IDENTITY='Developer ID Application: Company Name (TEAMID)'
export TEST_AGENT_NOTARY_PROFILE='TEST_AGENT_NOTARY_PROFILE'
```

## 3. 构建、签名、公证、staple 和验证

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
./scripts/sign-notarize-macos.sh
```

脚本步骤：

1. `CI=true pnpm desktop:package`
2. 使用 `TEST_AGENT_MACOS_IDENTITY` 和 hardened runtime entitlements 构建
3. `codesign --verify --deep --strict --verbose=2`
4. `xcrun notarytool submit ... --wait`
5. `xcrun stapler staple`
6. 再次 codesign verify
7. `spctl --assess --type execute --verbose`
8. 输出 ZIP 与 app.asar SHA256

## 4. 失败处理

- 缺少环境变量：脚本 exit 2，不会开始签名。
- 证书不存在：`security find-identity -v -p codesigning` 检查钥匙串。
- 签名失败：保留未发布产物，不提交公证。
- 公证失败：读取 notarytool log，修正 entitlements/bundle 内容后重试。
- staple 失败：确认公证状态为 Accepted，再重试。

## 5. 当前实际结果

- `./scripts/sign-notarize-macos.sh` 在缺少 `TEST_AGENT_MACOS_IDENTITY` 时 exit 2，符合 fail-closed。
- 当前产物仍是未签名本地开发包。
