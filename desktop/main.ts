import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron'
import type { WebContents } from 'electron'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DesktopAppService } from '../src/desktop/app-service.ts'
import type { SecretCodec } from '../src/desktop/model-service.ts'
import type { SaveCredentialInput } from '../src/desktop/credential-service.ts'
import type {
  CreateProjectInput,
  SaveProjectConfigInput,
  StartAgentInput,
  StartPerformanceInput,
  StartReplayInput,
} from '../src/desktop/types.ts'
import type { EngineKind } from '../src/engines/types.ts'
import { assertSafeEngine, redactSensitiveText } from '../src/desktop/security.ts'

const smokeTest = process.argv.includes('--smoke-test') || process.argv.includes('--smoke-ui')
const smokeUi = process.argv.includes('--smoke-ui')
let mainWindow: BrowserWindow | undefined
let service: DesktopAppService
let trustedRendererUrl = ''
let shutdownStarted = false
let shutdownComplete = false

if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => {
  if (mainWindow === undefined) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  app.setAppUserModelId('com.testagent.workbench')
  service = new DesktopAppService({
    appDataDirectory: app.getPath('userData'),
    appVersion: app.getVersion(),
    secretCodec: electronSecretCodec(),
  })
  await service.initialize()
  await mkdir(app.getPath('userData'), { recursive: true })

  // One-shot headless credential provisioning for scripted setup. The payload
  // file is deleted immediately after reading; the secret is only persisted
  // through the encrypted credential store (safeStorage on macOS).
  const importArgument = process.argv.find(argument => argument.startsWith('--import-credential-file='))
  if (importArgument !== undefined) {
    const file = importArgument.slice('--import-credential-file='.length)
    try {
      const raw = await readFile(file, 'utf8')
      await rm(file, { force: true })
      const input = JSON.parse(raw) as SaveCredentialInput
      const saved = await service.credentials.save(input)
      console.log(`TEST_AGENT_CREDENTIAL_SAVED=${saved.reference}`)
    } catch (error) {
      console.error(`credential import failed: ${redactSensitiveText((error as Error).message)}`)
      process.exitCode = 1
    }
    shutdownComplete = true
    app.quit()
    return
  }

  registerIpc()
  await createWindow()
  installMenu()

  if (smokeUi) {
    const result = await runUiSmoke(service)
    console.log(`TEST_AGENT_DESKTOP_UI_SMOKE=${result.ok ? 'ready' : 'failed'}`)
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
    shutdownComplete = true
    app.quit()
    return
  }

  if (smokeTest) {
    const rendererReady = await mainWindow?.webContents.executeJavaScript(
      `(async () => {
        const boot = await window.testAgent?.bootstrap()
        if (typeof boot?.appVersion !== 'string') return false
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          const createButton = document.querySelector('[data-action="create-project"]')
          if (createButton instanceof HTMLButtonElement) {
            createButton.click()
            await new Promise(resolve => setTimeout(resolve, 0))
            const dialog = document.querySelector('.modal[role="dialog"]')
            const input = document.querySelector('#text-prompt-input')
            if (!(dialog instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return false
            document.querySelector('#text-prompt-cancel')?.click()
            return document.querySelector('.modal-backdrop') === null
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return false
      })()`,
      true,
    ).catch(() => false)
    const modelConfig = await service.getModelConfig()
    console.log(`TEST_AGENT_DESKTOP_SMOKE=${rendererReady === true ? 'ready' : 'failed'}`)
    console.log(`TEST_AGENT_SECURE_STORAGE=${modelConfig.encryptionAvailable ? 'available' : 'unavailable'}`)
    if (rendererReady !== true) process.exitCode = 1
    shutdownComplete = true
    app.quit()
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch(error => {
  console.error(`desktop startup failed: ${redactSensitiveText((error as Error).message)}`)
  process.exitCode = 1
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || smokeTest) app.quit()
})

app.on('before-quit', event => {
  if (shutdownComplete || smokeTest) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  void service.shutdown()
    .catch(error => console.error(`shutdown cleanup failed: ${redactSensitiveText((error as Error).message)}`))
    .finally(() => {
      shutdownComplete = true
      app.quit()
    })
})

async function createWindow(): Promise<void> {
  const rendererPath = join(__dirname, 'renderer', 'index.html')
  trustedRendererUrl = pathToFileURL(rendererPath).toString()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 720,
    title: 'Test Agent Workbench',
    backgroundColor: '#f1eadb',
    show: !smokeTest,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedRendererUrl) event.preventDefault()
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  await mainWindow.loadFile(rendererPath)
}

function registerIpc(): void {
  handle('app:bootstrap', () => service.bootstrap())
  handle('model:config:get', () => service.getModelConfig())
  handle('model:config:save', input => service.saveModelConfig(input))
  handle('model:config:test', () => service.testModelConnection())
  handle('credentials:list', () => service.listCredentials())
  handle('credentials:save', input => service.saveCredential(input))
  handle('credentials:delete', id => service.deleteCredential(id))
  handle('credentials:test', reference => service.testCredential(reference))
  handle('project:create', async (input: CreateProjectInput) => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '选择新项目所在目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    return await service.createProject(input, result.filePaths[0])
  })
  handle('project:open', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '打开 Test Agent 项目',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    return await service.openProject(result.filePaths[0])
  })
  handle('project:switch', async (path: string) => service.switchProject(path))
  handle('project:importHar', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '导入 HAR 文件',
      properties: ['openFile'],
      filters: [{ name: 'HTTP Archive', extensions: ['har', 'json'] }],
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    return await service.importHar(result.filePaths[0])
  })
  handle('project:saveConfig', async (input: SaveProjectConfigInput) => service.saveConfig(input))
  handle('selector:engineExecutable', async (engine: EngineKind) => {
    const safeEngine = assertSafeEngine(engine)
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: `选择 ${safeEngine} 可执行文件`,
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('engines:check', async () => service.checkEngines())
  handle('script:generate', async (engine: EngineKind) => service.generateScript(assertSafeEngine(engine)))
  handle('test:replay', async (input?: StartReplayInput) => service.startReplay(input))
  handle('test:performance', async (input: StartPerformanceInput) => service.startPerformance(input))
  handle('tasks:list', async () => service.listTasks())
  handle('tasks:get', async (taskId: string) => service.getTask(taskId))
  handle('tasks:cancel', async (taskId: string) => service.cancelTask(taskId))
  handle('tasks:logs', async (taskId: string) => service.taskLogs(taskId))
  handle('agent:preview', async (goal: string, engine: EngineKind | 'none') => service.previewAgentPlan(goal, engine))
  handle('agent:preview-code', async (javaPath: string, goal: string) => service.previewCodeAgentPlan(javaPath, goal))
  handle('agent:start', async (input: StartAgentInput) => service.startAgent(input))
  handle('agent:get', async (taskId: string) => service.getAgentTask(taskId))
  handle('agent:analyze', async (taskId: string) => service.analyzeAgentTask(taskId))
  handle('artifact:open', async (path: string) => {
    const resolved = await service.resolveArtifact(path)
    const error = await shell.openPath(resolved)
    if (error.length > 0) throw new Error(error)
  })
  handle('ui:list', async () => service.listUiCases())
  handle('ui:get', async (caseId: string, version?: number) => service.getUiCase(caseId, version))
  handle('ui:save', async (input: unknown, expectedVersion?: number) => service.saveUiCase(input, expectedVersion))
  handle('ui:import-recording', async (input: unknown, caseId: string) => service.importUiRecording(input, caseId))
  handle('ui:run', async (caseId: string, version?: number) => service.runUiCase(caseId, version))
  handle('ui:choose-recording', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '导入 UI 操作录制 JSON',
      properties: ['openFile'],
      filters: [{ name: 'UI recording', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths[0] === undefined) return null
    const raw = await readFile(result.filePaths[0], 'utf8')
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('UI recording exceeds the 1 MiB import limit')
    return JSON.parse(raw) as unknown
  })
  handle('assets:list', async () => service.listAssets())
  handle('assets:scan', async () => service.scanAssets())
  handle('assets:get', async (assetId: string, version?: number) => service.getAsset(assetId, version))
  handle('assets:save', async (input: unknown, expectedVersion?: number) => service.saveAsset(input, expectedVersion))
  handle('assets:execute', async (assetId: string) => service.executeAsset(assetId))
  handle('assets:history', async (assetId: string) => service.assetHistory(assetId))
  handle('assets:compare', async (assetId: string, leftRunId?: string, rightRunId?: string) => service.compareAssetRuns(assetId, leftRunId, rightRunId))
  handle('code:list', async () => service.listCodeAnalyses())
  handle('code:get', async (analysisId: string) => service.getCodeAnalysis(analysisId))
  handle('code:analyze', async (path: string) => service.analyzeCode(path))
  handle('code:choose-source', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '选择 Java 源码目录',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('code:choose-archive', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '选择 WAR 或 class 文件',
      properties: ['openFile'],
      filters: [{ name: 'Java archive/class', extensions: ['war', 'class'] }],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle('coverage:list', async () => service.listCoverageAnalyses())
  handle('coverage:get', async (analysisId: string) => service.getCoverageAnalysis(analysisId))
  handle('coverage:analyze', async (codeAnalysisId: string, runtimeCoveragePath?: string) => service.analyzeCoverage(codeAnalysisId, runtimeCoveragePath))
  handle('coverage:execute-candidate', async (analysisId: string, candidateId: string) => service.executeCoverageCandidate(analysisId, candidateId))
  handle('coverage:choose-runtime', async () => {
    const result = await dialog.showOpenDialog(requireWindow(), {
      title: '选择运行时覆盖 JSON（可选）',
      properties: ['openFile'],
      filters: [{ name: 'Runtime coverage', extensions: ['json'] }],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
}

function handle(channel: string, callback: (...args: any[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event.sender, event.senderFrame?.url)
    try {
      return await callback(...args)
    } catch (error) {
      throw new Error(redactSensitiveText((error as Error).message))
    }
  })
}

function assertSender(sender: WebContents, frameUrl: string | undefined): void {
  if (mainWindow === undefined || sender !== mainWindow.webContents) throw new Error('untrusted IPC sender')
  if (frameUrl !== undefined && frameUrl !== trustedRendererUrl) throw new Error('untrusted IPC frame')
}

function requireWindow(): BrowserWindow {
  if (mainWindow === undefined) throw new Error('application window is unavailable')
  return mainWindow
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Test Agent',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]))
}

async function runUiSmoke(service: DesktopAppService): Promise<{
  ok: boolean
  task_id?: string
  run_id?: string
  status?: string
  steps_passed?: number
  steps_total?: number
  error?: string
}> {
  let server: Server | undefined
  let projectRoot: string | undefined
  try {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<main><button type="button">Ready</button><p data-testid="status">ready</p></main>')
    })
    await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('UI smoke server has no port')
    const origin = `http://127.0.0.1:${address.port}`
    const parent = await mkdtemp(join(app.getPath('temp'), 'test-agent-smoke-ui-'))
    const project = await service.createProject({ name: 'Playwright smoke' }, parent)
    projectRoot = project.path
    await service.saveConfig({
      target: { baseUrl: origin, allowedOrigins: [origin], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 2000, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'Electron packaged UI smoke only' },
    })
    const now = new Date().toISOString()
    await service.uiCases.save({
      schema_version: 'test-agent.ui-case/v1',
      case_id: 'desktop-playwright-smoke',
      name: 'Packaged Playwright smoke',
      version: 1,
      target_url: `${origin}/`,
      allowed_origins: [origin],
      timeout_ms: 10_000,
      headless: true,
      steps: [
        { id: 'open', action: 'navigate', url: `${origin}/` },
        { id: 'status', action: 'assert', assertion: 'containsText', locator: { kind: 'testId', value: 'status' }, expected: 'ready' },
      ],
      created_at: now,
      updated_at: now,
    })
    const started = await service.runUiCase('desktop-playwright-smoke')
    const snapshot = await service.tasks.waitForTask(started.task_id)
    return {
      ok: snapshot.task.status === 'passed',
      task_id: snapshot.task.task_id,
      run_id: snapshot.task.run_id,
      status: snapshot.task.status,
      steps_passed: snapshot.task.result_summary?.passed as number | undefined,
      steps_total: snapshot.task.result_summary?.total as number | undefined,
      ...snapshot.task.error === undefined ? {} : { error: redactSensitiveText(snapshot.task.error) },
    }
  } catch (error) {
    return { ok: false, error: redactSensitiveText((error as Error).message) }
  } finally {
    await service.shutdown().catch(() => undefined)
    await new Promise<void>(resolve => server?.close(() => resolve()))
    if (projectRoot !== undefined) await rm(projectRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

function electronSecretCodec(): SecretCodec {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: value => safeStorage.encryptString(value).toString('base64'),
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  }
}
