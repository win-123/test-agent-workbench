# 桌面程序启动入口与发布产物

更新日期：2026-10-30

## 1. 启动入口

### 开发环境

```sh
cd /Users/ztl/Downloads/AIProject/test-agent
pnpm desktop:run
```

- 源码入口：`desktop/main.ts`（Electron 主进程）
- 打包入口（构建产物）：`dist/desktop/main.cjs`
- 窗口渲染界面：`desktop/renderer/index.html` + `app.ts` + `styles.css`

### macOS 打包产物（本机可直接双击）

- 应用：`release/mac-arm64/Test Agent Workbench.app`
- 可执行文件：`release/mac-arm64/Test Agent Workbench.app/Contents/MacOS/Test Agent Workbench`
- 安装镜像：`release/Test Agent Workbench-0.1.0-arm64.dmg`（双击挂载后，把应用拖入 Applications）
- 免安装压缩包：`release/Test Agent Workbench-0.1.0-arm64-mac.zip`

### Windows 便携版（解压后双击 exe）

- 压缩包：`release/Test Agent Workbench-0.1.0-win-x64-portable.zip`
- 解压任意目录后运行：`Test Agent Workbench/Test Agent Workbench.exe`
- 同目录保留了未压缩版本：`release/win-x64-portable/`（仅用于校验，不要直接分发该目录）

## 2. 重新构建

```sh
# macOS .app + .zip + .dmg（arm64，未签名）
pnpm desktop:package

# Windows x64 便携版 zip（首次会下载 Electron win32-x64 运行时并缓存）
pnpm desktop:package:win
```

`desktop:package` 流程：构建 `dist/desktop` → electron-builder 产出 `.app` → ditto 压 zip → hdiutil 生成 DMG（内含应用和 /Applications 快捷方式）。

`desktop:package:win` 流程：构建 `dist/desktop` → 获取 Electron win32-x64 运行时（npmmirror 优先、GitHub 兜底）→ 组装 `resources/app`（主进程 + 渲染进程 + playwright 运行时依赖）→ 重命名 `electron.exe` 为 `Test Agent Workbench.exe` → zip 打包。

## 3. 产物校验（SHA256）

```text
546551a129c4a56e04e27335e93ef0deca5a4b077265988d729ba25a6e0374f9  Test Agent Workbench-0.1.0-arm64.dmg
ecf01b591747b5664fdb682da74c07810672be1ad188b541a1215e42d08ab33f  Test Agent Workbench-0.1.0-arm64-mac.zip
4f4e264adf794ec8185453c70353f3cab0c1c6da4454a01ff4930e241dc4d27b  Test Agent Workbench-0.1.0-win-x64-portable.zip
```

## 4. 已验证 / 未验证

已验证（本机 macOS arm64）：

- DMG 可挂载，包含 `.app` 与 Applications 快捷方式。
- 打包后的 `.app` 以 `--smoke-test` 启动：`TEST_AGENT_DESKTOP_SMOKE=ready`，安全存储 available。
- Windows 便携 zip 结构完整：包含 `Test Agent Workbench.exe`、`resources/app/dist/desktop/main.cjs`、`package.json` 与 playwright 运行时依赖；无 ``__MACOSX`` 垃圾目录。

未验证 / 限制：

- **Windows exe 未在真实 Windows 机器上运行验证**，仅完成结构校验。分发前建议在一台 Windows 10/11 x64 机器上解压双击验证。
- 两个平台的产物都**未签名**：macOS 首次打开需右键 → 打开（或系统设置里允许）；Windows SmartScreen 可能提示"未知发布者"，需选择"仍要运行"。
- Windows 目前是**便携版**（解压即用），不是 NSIS 安装器。生成 `.exe` 安装包需要在 Windows 机器上运行 electron-builder（`--win nsis`），或在本机安装 Wine；当前环境两者都不具备。
- Windows exe 的文件属性沿用Electron 运行时元数据（未通过 rcedit 修改，因无 Wine），不影响启动。
- macOS 正式签名与公证流程见 `MACOS_RELEASE.md`。

## 5. 数据位置

打包后的应用与开发模式一致：用户数据、项目、安全凭据存储在系统用户目录（macOS：`~/Library/Application Support/test-agent-workbench`；Windows：`%APPDATA%\test-agent-workbench`），卸载应用不会删除这些数据。
