import type {
  AgentPlanPreview,
  AgentTaskView,
  DesktopApi,
  DesktopRequestView,
  EngineStatus,
  LogChunk,
  ProjectConfig,
  ProjectSnapshot,
  SaveProjectConfigInput,
  ScriptGenerationResult,
  TaskSnapshot,
  UnifiedTaskSummary,
} from '../../src/desktop/types.ts'
import type { PublicModelConfig } from '../../src/desktop/model-service.ts'
import type { PublicCredential } from '../../src/desktop/credential-service.ts'
import type { EngineKind } from '../../src/engines/types.ts'
import type { UiCase, UiCaseSummary } from '../../src/ui/types.ts'
import type { AssetComparison, AssetRunHistory, AssetSummary, TestAsset } from '../../src/assets/types.ts'
import type { JavaAnalysis, JavaAnalysisSummary } from '../../src/code/types.ts'
import type { CoverageAnalysis, CoverageAnalysisSummary } from '../../src/coverage/types.ts'

declare global {
  interface Window {
    testAgent: DesktopApi
  }
}

interface ViewState {
  project?: ProjectSnapshot
  tasks: UnifiedTaskSummary[]
  engines: EngineStatus[]
  view: string
  selectedRequest?: DesktopRequestView
  requestFilter: string
  selectedRequestOrders: number[]
  selectedTaskId?: string
  selectedTask?: TaskSnapshot
  logs: LogChunk[]
  script?: ScriptGenerationResult
  agentGoal: string
  agentEngine: EngineKind | 'none'
  agentPreview?: AgentPlanPreview
  agentTask?: AgentTaskView
  agentConfirmed: boolean
  modelConfig: PublicModelConfig
  modelMessage?: string
  credentials: PublicCredential[]
  selectedCredentialId?: string
  pendingCredentialRef?: string
  credentialMessage?: string
  uiCases: UiCaseSummary[]
  selectedUiCase?: UiCaseSummary
  uiCaseText: string
  assets: AssetSummary[]
  selectedAsset?: TestAsset
  assetHistory?: AssetRunHistory
  assetComparison?: AssetComparison
  codeAnalyses: JavaAnalysisSummary[]
  coverageAnalyses: CoverageAnalysisSummary[]
  selectedCode?: JavaAnalysis
  selectedCoverage?: CoverageAnalysis
  lastCodePath?: string
  runtimeCoveragePath?: string
}

interface TextPromptOptions {
  title: string
  description: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  multiline?: boolean
  maxLength?: number
  validate?: (value: string) => string | undefined
}

const AUTH_SCOPE_TEMPLATE = `环境：请填写已授权的非生产测试环境
账号：请填写专用测试账号
数据范围：请填写允许操作的业务数据
允许操作：请填写接口、HTTP 方法和范围
有效期：请填写起止时间
禁止：生产数据、删除、支付、审批及未列明操作`

const app = document.querySelector<HTMLDivElement>('#app')!
if (app === null) throw new Error('app mount point is missing')

const state: ViewState = {
  tasks: [],
  engines: [],
  view: 'overview',
  requestFilter: '',
  selectedRequestOrders: [],
  logs: [],
  agentGoal: '',
  agentEngine: 'k6',
  agentConfirmed: false,
  modelConfig: {
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    chatPath: '/chat/completions',
    timeoutMs: 30_000,
    maxTokens: 4096,
    hasApiKey: false,
    encryptionAvailable: false,
  },
  credentials: [],
  uiCases: [],
  uiCaseText: '',
  assets: [],
  codeAnalyses: [],
  coverageAnalyses: [],
}

let pollTimer: number | undefined
let cancelActiveTextPrompt: (() => void) | undefined

void initialize()

async function initialize(): Promise<void> {
  try {
    const boot = await window.testAgent.bootstrap()
    state.project = boot.project
    state.selectedRequestOrders = boot.project?.requests.map(request => request.order) ?? []
    state.tasks = boot.tasks
    state.engines = boot.engines
    state.modelConfig = boot.modelConfig
    state.credentials = boot.credentials
    state.uiCases = boot.uiCases
    state.assets = boot.assets
    state.codeAnalyses = boot.codeAnalyses
    state.coverageAnalyses = boot.coverageAnalyses
    bindDelegatedInput()
    render()
    startPolling()
  } catch (error) {
    showFatal(error)
  }
}

interface DraftSnapshot {
  values: Map<string, { value: string; checked: boolean }>
  scroll: { window: number; lists: number[] }
  focus?: { id: string; selectionStart: number | null; selectionEnd: number | null }
}

function render(preserveUi = true): void {
  const snapshot = preserveUi ? captureUiSnapshot() : undefined
  app.innerHTML = state.project === undefined ? renderWelcome() : renderShell()
  bindActions()
  if (snapshot !== undefined) restoreUiSnapshot(snapshot)
}

function captureUiSnapshot(): DraftSnapshot {
  const values = new Map<string, { value: string; checked: boolean }>()
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-draft]').forEach(element => {
    if (element.id.length !== 0) values.set(element.id, { value: element.value, checked: element instanceof HTMLInputElement && element.checked })
  })
  const focusTarget = document.activeElement
  const focus = focusTarget instanceof HTMLInputElement || focusTarget instanceof HTMLTextAreaElement
    ? focusTarget.id.length !== 0
      ? { id: focusTarget.id, selectionStart: focusTarget.selectionStart, selectionEnd: focusTarget.selectionEnd }
      : undefined
    : undefined
  return {
    values,
    scroll: {
      window: window.scrollY,
      lists: [...document.querySelectorAll<HTMLElement>('.scroll-list')].map(element => element.scrollTop),
    },
    focus,
  }
}

function restoreUiSnapshot(snapshot: DraftSnapshot): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-draft]').forEach(element => {
    const draft = snapshot.values.get(element.id)
    if (draft === undefined) return
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) element.checked = draft.checked
    else element.value = draft.value
  })
  window.scrollTo({ top: snapshot.scroll.window })
  document.querySelectorAll<HTMLElement>('.scroll-list').forEach((element, index) => {
    const top = snapshot.scroll.lists[index]
    if (top !== undefined) element.scrollTop = top
  })
  if (snapshot.focus === undefined) return
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${snapshot.focus.id}`)
  if (element === null) return
  element.focus()
  if (snapshot.focus.selectionStart !== null && snapshot.focus.selectionEnd !== null) {
    element.setSelectionRange(snapshot.focus.selectionStart, snapshot.focus.selectionEnd)
  }
}

function renderWelcome(): string {
  return `
    <main class="main">
      <section class="empty-state">
        <p class="eyebrow">Local test operations</p>
        <h3>把请求、负载和 Agent 证据放进同一个工作台。</h3>
        <p>Test Agent 在本地复用已验证的 HAR 回放、k6/JMeter 执行器与 Agent 编排。桌面界面不重写测试核心，也不把未执行的结果伪装成报告。</p>
        <div class="empty-actions">
          <button class="button primary" data-action="create-project">创建测试项目</button>
          <button class="button" data-action="open-project">打开已有项目</button>
        </div>
      </section>
      <section class="card" style="margin-top:18px">
        <h3>模型网关</h3>
        ${renderModelConfig()}
      </section>
    </main>
  `
}

function renderShell(): string {
  return `
    <div class="shell">
      <aside class="rail">
        <header class="brand">
          <h1>Test Agent<br>Workbench</h1>
          <p>Local evidence / v0.1</p>
        </header>
        <nav class="nav">
          ${navButton('overview', '项目总览', '01')}
          ${navButton('api', 'API 实验台', '02')}
          ${navButton('performance', '负载测试', '03')}
          ${navButton('ui', 'UI 自动化', '04')}
          ${navButton('assets', '测试资产', '05')}
          ${navButton('code', '代码与覆盖', '06')}
          ${navButton('runs', '运行记录', '07')}
          ${navButton('agent', 'Agent 编排', '08')}
        </nav>
        <footer class="rail-footer">
          <div class="project-mini">
            <strong>${escapeHtml(state.project?.config.name ?? '')}</strong>
            <span>${escapeHtml(state.project?.harFileName ?? '尚未导入 HAR')}</span>
          </div>
          <button class="button subtle" data-action="open-project">切换项目</button>
        </footer>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <p class="eyebrow">${escapeHtml(viewEyebrow())}</p>
            <h2>${escapeHtml(viewTitle())}</h2>
          </div>
          <div class="topbar-actions">
            <button class="button" data-action="import-har">导入 HAR</button>
            ${state.view === 'runs' ? '<button class="button subtle" data-action="refresh-tasks">刷新记录</button>' : ''}
          </div>
        </header>
        <section class="content">${renderView()}</section>
      </main>
    </div>
  `
}

function navButton(view: string, label: string, index: string): string {
  return `<button class="${state.view === view ? 'active' : ''}" data-view="${view}"><span>${label}</span><span class="nav-index">${index}</span></button>`
}

function renderView(): string {
  if (state.view === 'api') return renderApiView()
  if (state.view === 'performance') return renderPerformanceView()
  if (state.view === 'ui') return renderUiView()
  if (state.view === 'assets') return renderAssetsView()
  if (state.view === 'code') return renderCodeView()
  if (state.view === 'runs') return renderRunsView()
  if (state.view === 'agent') return renderAgentView()
  return renderOverview()
}

function renderOverview(): string {
  const project = state.project
  if (project === undefined) return ''
  const target = project.config.target.baseUrl || '未配置目标'
  return `
    <div class="grid three">
      ${metric('HAR 请求', String(project.requests.length), project.harFileName ?? '等待导入')}
      ${metric('目标授权', project.config.authorization.confirmed ? '已确认' : '未确认', target)}
      ${metric('运行记录', String(state.tasks.length), state.tasks[0]?.title ?? '尚无执行')}
    </div>
    <div class="split" style="margin-top:18px">
      <section class="card">
        <h3>项目证据链</h3>
        <p>项目配置、脱敏 HAR、脚本、原始日志和统一报告均保存在项目目录内。运行过程中禁止切换项目或修改执行参数。</p>
        <div class="inline-actions">
          <span class="pill">${project.requests.length} requests</span>
          <span class="pill">${state.engines.filter(engine => engine.installed).length} engines ready</span>
          <span class="pill">${project.config.api.assertions.length} assertions</span>
        </div>
        <div class="inline-actions" style="margin-top:16px">
          <button class="button primary" data-view="api">打开 API 实验台</button>
          <button class="button" data-view="performance">负载测试</button>
          <button class="button" data-view="agent">Agent 编排</button>
        </div>
      </section>
      <section class="card">
        <h3>快速指引</h3>
        <p>${project.harFileName === undefined ? '先导入 HAR。导入内容会经过解析、大小限制和敏感字段脱敏，再保存到项目。' : '在 API 实验台查看请求并执行真实回放；两种负载引擎均可生成独立脚本。'}</p>
        <div class="notice">所有测试目标必须显式授权。未确认授权时，回放、负载与 Agent 执行均会被服务层拒绝。</div>
      </section>
    </div>
    <div style="margin-top:18px">${renderConfigForm()}</div>
  `
}

function renderApiView(): string {
  if (state.project === undefined) return ''
  const requests = state.project.requests
  const selected = state.selectedRequest
  const filter = state.requestFilter.trim()
  const visibleRequests = requests.filter(request => requestMatchesFilter(request, filter))
  const selectedOrders = new Set(state.selectedRequestOrders)
  const selectedCount = requests.filter(request => selectedOrders.has(request.order)).length
  const allVisibleSelected = visibleRequests.length > 0 && visibleRequests.every(request => selectedOrders.has(request.order))
  const someVisibleSelected = visibleRequests.some(request => selectedOrders.has(request.order))
  const replayLabel = selectedCount === requests.length && requests.length > 0
    ? `执行全部回放 (${requests.length})`
    : selectedCount > 0
      ? `执行选中回放 (${selectedCount})`
      : '请选择要回放的请求'
  return `
    <div class="split">
      <section class="card">
        <h3>HAR 请求</h3>
        ${requests.length === 0 ? '<p>尚未导入 HAR，或导入文件没有可展示的请求。</p>' : `
          <div class="request-toolbar">
            <div class="request-filter">
              <label for="request-filter">筛选</label>
              <input id="request-filter" value="${escapeHtml(state.requestFilter)}" placeholder="输入序号、GET/POST 或路径">
            </div>
            <span class="pill">已选 ${selectedCount}/${requests.length}</span>
            <button class="button subtle" data-action="select-visible-requests" ${allVisibleSelected ? 'disabled' : ''}>全选当前结果</button>
            <button class="button subtle" data-action="clear-request-selection" ${selectedCount === 0 ? 'disabled' : ''}>清空选择</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th class="select-column"><input id="request-select-all" type="checkbox" aria-label="全选当前筛选结果" ${allVisibleSelected ? 'checked' : ''} ${visibleRequests.length === 0 ? 'disabled' : ''}></th>
                <th>#</th><th>方法</th><th>路径</th><th>请求头</th>
              </tr></thead>
              <tbody>
                ${visibleRequests.length === 0 ? '<tr><td colspan="5" class="muted">没有匹配当前筛选条件的请求。</td></tr>' : visibleRequests.map(request => `
                  <tr class="${selected?.order === request.order ? 'selected' : ''}" data-request="${request.order}">
                    <td class="select-column"><input type="checkbox" data-request-select="${request.order}" aria-label="选择请求 ${request.order}" ${selectedOrders.has(request.order) ? 'checked' : ''}></td>
                    <td class="mono">${request.order}</td>
                    <td><span class="method">${escapeHtml(request.method)}</span></td>
                    <td class="mono">${escapeHtml(request.path)}</td>
                    <td class="mono">${request.headers.length}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
        <div class="inline-actions" style="margin-top:14px">
          <button class="button primary" data-action="start-replay" ${selectedCount === 0 ? 'disabled' : ''}>${replayLabel}</button>
          <button class="button" data-action="generate-k6" ${requests.length === 0 ? 'disabled' : ''}>生成 k6</button>
          <button class="button" data-action="generate-jmeter" ${requests.length === 0 ? 'disabled' : ''}>生成 JMeter</button>
        </div>
        <div style="margin-top:18px;border-top:1px solid rgba(31,28,24,.12);padding-top:16px">
          <h3>Credentials（安全凭据）</h3>
          ${renderCredentialManager()}
        </div>
      </section>
      <section class="card">
        <h3>${selected === undefined ? '请求详情' : `${selected.method} ${selected.path}`}</h3>
        ${selected === undefined ? '<p>选择左侧请求查看脱敏后的 URL、请求头、查询参数和请求体。</p>' : renderRequestDetail(selected)}
        ${renderScriptPreview()}
      </section>
    </div>
    <div style="margin-top:18px">${renderConfigForm()}</div>
  `
}

function requestMatchesFilter(request: DesktopRequestView, filter: string): boolean {
  if (filter.length === 0) return true
  return `${request.order} ${request.method} ${request.path} ${request.url}`.toLowerCase().includes(filter.toLowerCase())
}

function renderRequestDetail(request: DesktopRequestView): string {
  const headers = Object.fromEntries(request.headers.map(header => [header.name, header.value]))
  return `
    <p class="mono muted">${escapeHtml(request.url)}</p>
    <div class="grid two">
      <div>
        <p class="eyebrow">请求头（Headers）</p>
        <pre class="code">${escapeHtml(JSON.stringify(headers, null, 2))}</pre>
      </div>
      <div>
        <p class="eyebrow">请求体（Body）</p>
        <pre class="code">${escapeHtml(request.body ?? '(no body)')}</pre>
      </div>
    </div>
  `
}

function renderPerformanceView(): string {
  const config = state.project?.config
  if (config === undefined) return ''
  return `
    <div class="grid two">
      ${state.engines.map(engine => renderEngineCard(engine)).join('')}
    </div>
    <div class="split" style="margin-top:18px">
      <section class="card">
        <h3>负载参数</h3>
        <div class="grid three">
          ${metric('Engine（执行引擎）', config.performance.engine.toUpperCase(), config.performance.engine === 'k6' ? 'k6 scenarios（k6 场景）' : 'JMeter thread group（线程组）')}
          ${metric('VUs（虚拟用户数）', String(config.performance.vus), '按项目配置执行')}
          ${metric('Timeout（超时）', `${Math.round(config.performance.timeoutMs / 1000)}s`, '超时由执行器终止子进程')}
        </div>
        <div class="inline-actions" style="margin-top:18px">
          <button class="button" data-action="generate-k6">生成并保存 k6 脚本</button>
          <button class="button" data-action="generate-jmeter">生成并保存 JMeter 脚本</button>
          <button class="button primary" data-action="start-performance">启动真实测试</button>
          <button class="button danger" data-action="cancel-selected">停止当前任务</button>
        </div>
        <div class="notice" style="margin-top:14px">一次只允许一个运行任务。脚本生成不发送网络请求；启动测试会真实访问已授权目标。</div>
      </section>
      <section class="card">
        <h3>脚本预览</h3>
        ${renderScriptPreview() || '<p>生成脚本后可在此检查并保存位置。</p>'}
      </section>
    </div>
    <div style="margin-top:18px">${renderConfigForm()}</div>
  `
}

function renderEngineCard(engine: EngineStatus): string {
  return `
    <article class="card">
      <div class="inline-actions" style="justify-content:space-between">
        <h3>${engine.engine.toUpperCase()}</h3>
        <span class="status ${engine.installed ? 'passed' : 'failed'}">${engine.installed ? '就绪（ready）' : '缺失（missing）'}</span>
      </div>
      <p class="mono muted">${escapeHtml(engine.executable ?? '未找到可执行文件')}</p>
      <p>${escapeHtml(engine.version ?? engine.error ?? '尚未检测')}</p>
      <button class="button subtle" data-action="choose-engine" data-engine="${engine.engine}">选择可执行文件</button>
    </article>
  `
}

function renderUiView(): string {
  const selected = state.selectedUiCase
  return `
    <div class="split">
      <section class="card">
        <div class="inline-actions" style="justify-content:space-between">
          <h3>版本化 UI 用例</h3>
          <button class="button subtle" data-action="import-ui-recording">导入录制 JSON</button>
        </div>
        ${state.uiCases.length === 0
          ? '<p>尚无 UI 用例。导入操作录制 JSON 后，可在右侧编辑并独立执行。</p>'
          : `<div class="scroll-list">${state.uiCases.map(item => `
              <div class="run-row ${selected?.case_id === item.case_id ? 'selected' : ''}" data-ui-case="${escapeHtml(item.case_id)}">
                <div>
                  <strong>${escapeHtml(item.name)}</strong>
                  <small>v${item.version} · ${item.step_count} steps · ${escapeHtml(item.case_id)}</small>
                </div>
                <span class="pill">UI</span>
              </div>
            `).join('')}</div>`}
      </section>
      <section class="card">
        <h3>${selected === undefined ? '用例编辑器' : `${escapeHtml(selected.name)} · v${selected.version}`}</h3>
        ${selected === undefined
          ? '<p>选择左侧用例查看结构化步骤、定位器、等待和断言。</p>'
          : `
            <p class="mono muted">${escapeHtml(selected.target_url)}</p>
            <div class="field">
              <label for="ui-case-json">UI case JSON（UI 用例 JSON；保存时自动递增版本）</label>
              <textarea id="ui-case-json" style="min-height:420px">${escapeHtml(state.uiCaseText)}</textarea>
            </div>
            <div class="inline-actions">
              <button class="button primary" data-action="save-ui-case">校验并保存新版本</button>
              <button class="button" data-action="run-ui-case">执行真实浏览器用例</button>
            </div>
            <div class="notice" style="margin-top:14px">浏览器仅允许访问用例声明的 origins；失败步骤保存截图，输入值不写入报告。</div>
          `}
      </section>
    </div>
  `
}

function renderAssetsView(): string {
  const selected = state.selectedAsset
  return `
    <div class="split">
      <section class="card">
        <div class="inline-actions" style="justify-content:space-between">
          <h3>资产目录</h3>
          <button class="button subtle" data-action="scan-assets">扫描原生格式</button>
        </div>
        ${state.assets.length === 0
          ? '<p>尚无资产。扫描会登记 HAR、UI 用例和 k6/JMeter 脚本，不转换原文件。</p>'
          : `<div class="scroll-list">${state.assets.map(asset => `
              <div class="run-row ${selected?.asset_id === asset.asset_id ? 'selected' : ''}" data-asset="${escapeHtml(asset.asset_id)}">
                <div>
                  <strong>${escapeHtml(asset.name)}</strong>
                  <small>${escapeHtml(asset.kind)} · v${asset.version} · ${asset.run_count} runs</small>
                </div>
                <span class="pill">${escapeHtml(asset.source_format)}</span>
              </div>
            `).join('')}</div>`}
      </section>
      <section class="card">
        <h3>${selected === undefined ? '资产详情' : escapeHtml(selected.name)}</h3>
        ${selected === undefined ? '<p>选择资产查看原生来源、环境引用、凭据引用和执行历史。</p>' : renderAssetDetail(selected)}
      </section>
    </div>
  `
}

function renderAssetDetail(asset: TestAsset): string {
  const history = state.assetHistory
  return `
    <div class="inline-actions" style="justify-content:space-between">
      <span class="pill">${escapeHtml(asset.kind)} / ${escapeHtml(asset.source_format)}</span>
      <span class="mono muted">v${asset.version}</span>
    </div>
    <p class="mono muted">${escapeHtml(asset.source_path)}</p>
    <div class="grid three">
      ${metric('环境', asset.environment.name, `${asset.environment.variable_refs.length} variable refs`)}
      ${metric('凭据引用', String(asset.credential_refs.length), '仅保存引用，不保存秘密')}
      ${metric('执行次数', String(history?.runs.length ?? 0), '关联既有任务与报告')}
    </div>
    <pre class="code">${escapeHtml(JSON.stringify(asset.execution, null, 2))}</pre>
    <div class="inline-actions">
      <button class="button primary" data-action="execute-asset">重复执行资产</button>
      <button class="button subtle" data-action="compare-asset" ${(history?.runs.length ?? 0) < 2 ? 'disabled' : ''}>比较最近两次真实运行</button>
    </div>
    ${renderAssetHistory(history)}
    ${renderAssetComparison()}
  `
}

function renderAssetHistory(history: AssetRunHistory | undefined): string {
  if (history === undefined || history.runs.length === 0) return '<p class="muted">尚无关联运行。</p>'
  return `
    <p class="eyebrow" style="margin-top:18px">运行历史（Run history）</p>
    <div class="scroll-list">
      ${history.runs.slice().reverse().map(run => `
        <div class="run-row">
          <div>
            <strong class="mono">${escapeHtml(run.run_id)}</strong>
            <small>${escapeHtml(run.status)} · ${escapeHtml(formatTime(run.finished_at ?? run.recorded_at))}</small>
          </div>
          <span class="pill">${Object.entries(run.metrics).map(([key, value]) => `${escapeHtml(key)}=${value === null ? 'n/a' : value}`).join(' ')}</span>
        </div>
      `).join('')}
    </div>
  `
}

function renderAssetComparison(): string {
  const comparison = state.assetComparison
  if (comparison === undefined) return ''
  return `
    <p class="eyebrow" style="margin-top:18px">历史对比（History comparison）</p>
    <p class="mono muted">${escapeHtml(comparison.left.run_id)} → ${escapeHtml(comparison.right.run_id)}</p>
    <div class="grid three">
      ${comparison.metrics.slice(0, 9).map(item => metric(
        item.name,
        item.right === null ? 'n/a' : String(round(item.right)),
        `left ${item.left ?? 'n/a'} · Δ ${item.delta ?? 'n/a'}`,
      )).join('')}
    </div>
    <div class="timeline" style="margin-top:14px">
      ${comparison.facts.map(fact => `<div class="timeline-item">${escapeHtml(fact)}</div>`).join('')}
      ${comparison.caveats.map(caveat => `<div class="timeline-item failed">${escapeHtml(caveat)}</div>`).join('')}
    </div>
  `
}

function renderCodeView(): string {
  const code = state.selectedCode
  return `
    <div class="card">
      <div class="inline-actions" style="justify-content:space-between">
        <div>
          <h3>Java 白盒分析与候选覆盖</h3>
          <p class="muted">源码和 WAR 分析完全独立于模型；静态分支不会被显示为真实覆盖率。</p>
        </div>
        <div class="inline-actions">
          <button class="button subtle" data-action="analyze-java-source">分析源码目录</button>
          <button class="button subtle" data-action="analyze-java-war">分析 WAR/class</button>
        </div>
      </div>
    </div>
    <div class="split" style="margin-top:18px">
      <section class="card">
        <h3>分析历史</h3>
        ${state.codeAnalyses.length === 0
          ? '<p>尚无分析记录。</p>'
          : `<div class="scroll-list">${state.codeAnalyses.map(item => `
              <div class="run-row ${code?.analysis_id === item.analysis_id ? 'selected' : ''}" data-code-analysis="${escapeHtml(item.analysis_id)}">
                <div>
                  <strong>${escapeHtml(item.input)}</strong>
                  <small>${escapeHtml(item.mode)} · ${item.classes} classes · ${item.endpoints} endpoints · ${item.branches} branches</small>
                </div>
                <span class="status ${item.uncertainties > 0 ? 'test_failed' : 'passed'}">${item.uncertainties} uncertain</span>
              </div>
            `).join('')}</div>`}
      </section>
      <section class="card">
        <h3>${code === undefined ? '证据详情' : `${escapeHtml(code.input)} · ${escapeHtml(code.mode)}`}</h3>
        ${code === undefined ? '<p>选择分析记录查看 endpoint、方法、分支、异常和不确定性证据。</p>' : renderCodeEvidence(code)}
      </section>
    </div>
    <div style="margin-top:18px">${renderCoverageSection()}</div>
  `
}

function renderCodeEvidence(analysis: JavaAnalysis): string {
  return `
    <div class="grid three">
      ${metric('源码文件', String(analysis.structure.source_files), analysis.structure.frameworks.join(', ') || '未识别框架')}
      ${metric('端点声明', String(analysis.endpoints.length), '静态映射')}
      ${metric('分支候选', String(analysis.branches.length), '不是覆盖率')}
    </div>
    <div class="notice" style="margin-top:14px">${escapeHtml(analysis.coverage.note)}</div>
    <p class="eyebrow" style="margin-top:18px">接口端点（Endpoints）</p>
    <div class="timeline">
      ${analysis.endpoints.length === 0 ? '<p class="muted">未识别端点；WAR 分析不会根据字节码猜测注解参数。</p>' : analysis.endpoints.map(endpoint => `
        <div class="timeline-item">
          <strong>${escapeHtml(endpoint.http_method)} ${escapeHtml(endpoint.path)}</strong>
          <div class="mono">${escapeHtml(endpoint.class_name)}.${escapeHtml(endpoint.method)}</div>
          <small>${escapeHtml(endpoint.evidence.file)}:${endpoint.evidence.line ?? '?'}${endpoint.request_body ? ' · request body' : ''}</small>
        </div>
      `).join('')}
    </div>
    <p class="eyebrow" style="margin-top:18px">高风险分支（High-risk branches）</p>
    <div class="timeline">
      ${analysis.branches.filter(branch => branch.risk === 'high').slice(0, 20).map(branch => `
        <div class="timeline-item failed">
          <strong>${escapeHtml(branch.method)} · ${escapeHtml(branch.kind)}</strong>
          <div>${escapeHtml(branch.condition)}</div>
          <small>${escapeHtml(branch.evidence.file)}:${branch.line ?? '?'}</small>
        </div>
      `).join('') || '<p class="muted">没有高风险静态分支。</p>'}
    </div>
    <p class="eyebrow" style="margin-top:18px">已知限制（Limitations）</p>
    <div class="timeline">
      ${analysis.uncertainties.map(item => `<div class="timeline-item needs_review"><strong>${escapeHtml(item.kind)}</strong><div>${escapeHtml(item.message)}</div></div>`).join('') || '<p class="muted">未记录额外限制。</p>'}
    </div>
    <div class="inline-actions" style="margin-top:16px">
      <button class="button primary" data-action="analyze-coverage">生成候选测试</button>
      <button class="button subtle" data-action="choose-runtime-coverage">${state.runtimeCoveragePath === undefined ? '附加运行时覆盖 JSON（可选）' : escapeHtml(state.runtimeCoveragePath.split('/').at(-1) ?? '')}</button>
      <button class="button" data-action="preview-code-agent">让 Agent 解释证据</button>
    </div>
  `
}

function renderCoverageSection(): string {
  const coverage = state.selectedCoverage
  return `
    <section class="card">
      <div class="inline-actions" style="justify-content:space-between">
        <h3>候选测试与真实执行证据</h3>
        <span class="pill">${state.coverageAnalyses.length} analyses</span>
      </div>
      ${state.coverageAnalyses.length === 0 ? '' : `
        <div class="inline-actions" style="margin:10px 0">
          ${state.coverageAnalyses.slice(0, 8).map(item => `
            <button class="button subtle" data-coverage="${escapeHtml(item.analysis_id)}">
              ${escapeHtml(formatTime(item.created_at))} · ${item.candidates.length} candidates
            </button>
          `).join('')}
        </div>
      `}
      ${coverage === undefined ? '<p>选择代码分析后生成候选。无运行时覆盖输入时，不计算覆盖率。</p>' : `
        <div class="grid three">
          ${metric('运行时覆盖', coverage.measurement.measured ? 'measured' : 'not measured', coverage.measurement.tool ?? '无运行时输入')}
          ${metric('作用域分支', String(coverage.measurement.matched_branches), `${coverage.measurement.covered_branches} covered`)}
          ${metric('作用域覆盖率', coverage.measurement.percentage === null ? 'n/a' : `${coverage.measurement.percentage.toFixed(1)}%`, coverage.measurement.note)}
        </div>
        <div class="timeline" style="margin-top:16px">
          ${coverage.candidates.map(candidate => `
            <div class="timeline-item ${candidate.execution?.status === 'passed' ? 'passed' : candidate.execution?.status === undefined ? '' : 'failed'}">
              <div class="inline-actions" style="justify-content:space-between">
                <strong>${escapeHtml(candidate.title)}</strong>
                <span class="pill ${candidate.priority === 'high' ? 'risk' : ''}">${escapeHtml(candidate.priority)} / ${escapeHtml(candidate.basis.evidence_type)}</span>
              </div>
              <div>${escapeHtml(candidate.hypothesis.statement)}</div>
              <small>${candidate.basis.evidence.map(item => `${item.file}:${item.line ?? '?'}`).join(', ')}</small>
              ${candidate.execution === undefined ? '' : `<div class="mono muted">run ${escapeHtml(candidate.execution.run_id ?? 'n/a')} · ${escapeHtml(candidate.execution.status)} · ${escapeHtml(candidate.execution.report_path ?? 'no report')}</div>`}
              ${candidate.execution?.report_path === undefined ? '' : `<button class="button subtle" data-action="open-artifact" data-path="${escapeHtml(candidate.execution.report_path)}">打开候选报告</button>`}
              ${candidate.executable_asset_id !== undefined && candidate.execution === undefined ? `<button class="button primary" data-action="execute-candidate" data-candidate="${escapeHtml(candidate.candidate_id)}">执行候选</button>` : ''}
            </div>
          `).join('') || '<p>没有生成候选。</p>'}
        </div>
        <div class="notice" style="margin-top:14px">${coverage.limitations.map(escapeHtml).join(' ')}</div>
      `}
    </section>
  `
}

function renderScriptPreview(): string {
  if (state.script === undefined) return ''
  return `
    <div style="margin-top:14px">
      <div class="inline-actions" style="justify-content:space-between">
        <span class="pill">${escapeHtml(state.script.engine)}</span>
        <button class="button subtle" data-action="open-script">打开脚本文件</button>
      </div>
      <p class="mono muted">${escapeHtml(state.script.path)}</p>
      <pre class="code">${escapeHtml(state.script.content.slice(0, 12000))}</pre>
    </div>
  `
}

function renderRunsView(): string {
  const task = state.selectedTask
  return `
    <div class="split">
      <section class="card">
        <h3>任务历史</h3>
        ${state.tasks.length === 0 ? '<p>尚无运行记录。执行 API 回放、负载测试或 Agent 计划后会出现在这里。</p>' : `
          <div class="scroll-list">
            ${state.tasks.map(item => `
              <div class="run-row ${state.selectedTaskId === item.task_id ? 'selected' : ''}" data-task="${escapeHtml(item.task_id)}">
                <div>
                  <strong>${escapeHtml(item.title)}</strong>
                  <small>${escapeHtml(item.task_id)} · ${escapeHtml(formatTime(item.created_at))}</small>
                </div>
                <span class="status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
              </div>
            `).join('')}
          </div>
        `}
      </section>
      <section class="card">
        <h3>${task === undefined ? '运行证据' : task.task.title}</h3>
        ${task === undefined ? '<p>选择任务查看真实报告、失败详情、工具调用和原始日志。</p>' : renderTaskDetail(task)}
      </section>
    </div>
  `
}

function renderTaskDetail(snapshot: TaskSnapshot): string {
  const task = snapshot.task
  const report = snapshot.report
  return `
    <div class="inline-actions" style="justify-content:space-between">
      <span class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
      <span class="mono muted">${escapeHtml(task.run_id ?? 'no run id')}</span>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="metric"><span>开始</span><strong style="font-size:20px">${escapeHtml(formatTime(task.started_at ?? task.created_at))}</strong></div>
      <div class="metric"><span>结束</span><strong style="font-size:20px">${escapeHtml(formatTime(task.finished_at ?? ''))}</strong></div>
    </div>
    ${report === undefined
      ? '<p class="muted">报告尚未生成。</p>'
      : isEngineReport(report)
        ? renderEngineMetrics(report)
        : isUiReport(report)
          ? renderUiMetrics(report)
          : renderReplayMetrics(report)}
    ${task.error === undefined ? '' : `<div class="notice" style="margin-top:14px">${escapeHtml(task.error)}</div>`}
    ${report === undefined || replayAuthFailures(report) === 0 ? '' : `<div class="notice" style="margin-top:14px"><strong>${replayAuthFailures(report)} 个请求被目标认证拒绝（HTTP 401/403）。</strong>常见原因：项目未绑定凭据、凭据已过期，或账号无权访问该接口。请到「API 实验台 → 凭据管理」保存有效登录凭据（Cookie / Bearer / 自定义 Header），并在项目配置的 Credential reference 中选择它；同时确认 Authorization scope 覆盖实际调用的接口。</div>`}
    <div class="inline-actions" style="margin-top:14px">
      ${task.report_path === undefined ? '' : `<button class="button subtle" data-action="open-artifact" data-path="${escapeHtml(task.report_path)}">打开报告文件</button>`}
      ${task.script_path === undefined ? '' : `<button class="button subtle" data-action="open-artifact" data-path="${escapeHtml(task.script_path)}">打开脚本</button>`}
      ${isActive(task.status) ? '<button class="button danger" data-action="cancel-selected">停止任务</button>' : ''}
    </div>
    ${state.logs.length === 0 ? '' : `
      <p class="eyebrow" style="margin-top:18px">实时日志（Live logs）</p>
      ${state.logs.map(log => `<pre class="code">${escapeHtml(`[${log.path}]\n${log.content}`)}</pre>`).join('')}
    `}
    ${snapshot.agent === undefined ? '' : renderAgentToolCalls(snapshot.agent)}
  `
}

function renderReplayMetrics(report: Extract<TaskSnapshot['report'], { requests: unknown[] }>): string {
  return `
    <div class="grid three">
      ${metric('请求总数', String(report.total), '真实回放报告')}
      ${metric('通过', String(report.passed), 'HTTP 与断言均通过')}
      ${metric('失败', String(report.failed), '失败详情见下')}
    </div>
    <div class="timeline" style="margin-top:14px">
      ${report.requests.filter(request => !request.passed).map(request => `
        <div class="timeline-item failed">
          <strong>${escapeHtml(request.method)} ${escapeHtml(request.path)}</strong>
          <div class="mono muted">HTTP ${request.status} · ${request.duration_ms} ms</div>
          <div>${escapeHtml(request.error ?? '断言失败')}</div>
        </div>
      `).join('') || '<p>所有已记录请求通过。</p>'}
    </div>
    ${report.correlation_results.length === 0 ? '' : `
      <p class="eyebrow" style="margin-top:18px">运行时关联变量（Runtime correlations）</p>
      <div class="timeline">
        ${report.correlation_results.map(result => `
          <div class="timeline-item ${result.status === 'extracted' ? '' : 'failed'}">
            <strong>${escapeHtml(result.variable_name)}</strong>
            <div class="mono muted">${escapeHtml(result.status)} · request ${result.source_index} -> ${result.target_indexes.join(', ')}</div>
            ${result.error === undefined ? '' : `<div>${escapeHtml(result.error)}</div>`}
          </div>
        `).join('')}
      </div>
    `}
  `
}

function renderUiMetrics(report: Extract<NonNullable<TaskSnapshot['report']>, { steps_total: number }>): string {
  return `
    <div class="grid three">
      ${metric('步骤总数', String(report.steps_total), '真实浏览器执行')}
      ${metric('通过', String(report.steps_passed), report.browser)}
      ${metric('失败', String(report.steps_failed), `${report.screenshots.length} failure screenshot(s)`)}
    </div>
    <div class="timeline" style="margin-top:14px">
      ${report.steps.map(step => `
        <div class="timeline-item ${escapeHtml(step.status)}">
          <strong>${escapeHtml(step.id)} · ${escapeHtml(step.action)}</strong>
          <div class="mono muted">${step.duration_ms} ms · ${escapeHtml(step.actual ?? 'no observed value')}</div>
          ${step.error === undefined ? '' : `<div>${escapeHtml(step.error)}</div>`}
        </div>
      `).join('')}
    </div>
    ${report.screenshots.length === 0 ? '' : `
      <p class="eyebrow" style="margin-top:14px">失败截图（Failure screenshots）</p>
      <div class="inline-actions">
        ${report.screenshots.map((path, index) => `<button class="button subtle" data-action="open-artifact" data-path="${escapeHtml(path)}">打开截图 ${index + 1}</button>`).join('')}
      </div>
    `}
  `
}

function renderEngineMetrics(report: Extract<TaskSnapshot['report'], { metrics: unknown }>): string {
  const metrics = report.metrics
  return `
    <div class="grid three">
      ${metric('成功率', metrics.total === 0 ? 'n/a' : `${((metrics.passed / metrics.total) * 100).toFixed(1)}%`, `${metrics.passed}/${metrics.total} real samples`)}
      ${metric('错误率', metrics.error_rate === null ? 'n/a' : `${(metrics.error_rate * 100).toFixed(2)}%`, '来自引擎结果')}
      ${metric('吞吐量', metrics.throughput_per_second === null ? 'n/a' : String(round(metrics.throughput_per_second)), metrics.throughput_basis)}
      ${metric('P90', formatMs(metrics.p90_response_ms), '真实引擎分位值')}
      ${metric('P95', formatMs(metrics.p95_response_ms), '真实引擎分位值')}
      ${metric('P99', formatMs(metrics.p99_response_ms), '真实引擎分位值')}
    </div>
    <div class="notice" style="margin-top:14px">${escapeHtml(report.evidence.status)} · raw result ${escapeHtml(report.evidence.raw_result_path ?? 'unavailable')}</div>
    ${report.diagnostics.length === 0 ? '' : `<div class="timeline" style="margin-top:14px">${report.diagnostics.map(item => `<div class="timeline-item failed"><strong>${escapeHtml(item.category)}</strong><div>${escapeHtml(item.message)}</div></div>`).join('')}</div>`}
  `
}

function renderAgentView(): string {
  return `
    <div class="split">
      <section class="card">
        <h3>模型网关</h3>
        ${renderModelConfig()}
      </section>
      <section class="card">
        <h3>描述测试目标</h3>
        <div class="field">
          <label for="agent-goal">Natural language goal（自然语言目标）</label>
          <textarea id="agent-goal" placeholder="例如：验证健康检查、回显和预期 500 失败，并生成 k6 真实执行报告。">${escapeHtml(state.agentGoal)}</textarea>
        </div>
        <div class="field">
          <label for="agent-engine">Engine（执行引擎）</label>
          <select id="agent-engine">
            <option value="k6" ${state.agentEngine === 'k6' ? 'selected' : ''}>k6</option>
            <option value="jmeter" ${state.agentEngine === 'jmeter' ? 'selected' : ''}>JMeter</option>
            <option value="none" ${state.agentEngine === 'none' ? 'selected' : ''}>不运行负载引擎</option>
          </select>
          <small class="field-hint">选择 Agent 计划中要调用的负载引擎；只做 API 验证时选择“不运行负载引擎”。</small>
        </div>
        <button class="button primary" data-action="preview-agent">生成结构化计划</button>
        <div class="notice" style="margin-top:14px">${escapeHtml(modelNotice())}</div>
        ${renderAgentTaskSummary()}
      </section>
      <section class="card">
        <h3>计划与执行</h3>
        ${state.agentPreview === undefined ? '<p>生成计划后，执行前会展示目标、工具、参数、风险与验收条件。</p>' : renderAgentPlan(state.agentPreview)}
      </section>
    </div>
    ${state.agentTask === undefined ? '' : `<div style="margin-top:18px">${renderAgentProgress(state.agentTask)}</div>`}
  `
}

function renderModelConfig(): string {
  const config = state.modelConfig
  return `
    <div class="grid two">
      <div class="field"><label for="model-provider">Provider（模型提供商）</label>
        <select id="model-provider" data-draft>
          <option value="openai-compatible" ${config.provider === 'openai-compatible' ? 'selected' : ''}>OpenAI compatible（OpenAI 兼容）</option>
          <option value="deepseek" ${config.provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
          <option value="custom-openai-compatible" ${config.provider === 'custom-openai-compatible' ? 'selected' : ''}>Custom OpenAI compatible（自定义 OpenAI 兼容）</option>
        </select>
        <small class="field-hint">选择模型网关协议；Agent 不可用时仍会降级生成确定性计划。</small>
      </div>
      <div class="field">
        <label for="model-name">Model（模型名称）</label>
        <input id="model-name" data-draft value="${escapeHtml(config.model)}" placeholder="例如：deepseek-chat">
        <small class="field-hint">填写网关实际提供的模型 ID，不是显示名称。</small>
      </div>
    </div>
    <div class="field">
      <label for="model-base-url">Base URL（基础地址）</label>
      <input id="model-base-url" data-draft placeholder="https://provider.example/v1" value="${escapeHtml(config.baseUrl)}">
      <small class="field-hint">填写模型服务根地址；通常以 <code>/v1</code> 结尾，不要填写具体对话接口。</small>
    </div>
    <div class="grid three">
      <div class="field">
        <label for="model-chat-path">Chat path（对话接口路径）</label>
        <input id="model-chat-path" data-draft value="${escapeHtml(config.chatPath)}" placeholder="/chat/completions">
        <small class="field-hint">相对于 Base URL，例如 <code>/chat/completions</code>。</small>
      </div>
      <div class="field">
        <label for="model-timeout">Timeout ms（超时毫秒）</label>
        <input id="model-timeout" data-draft type="number" min="1000" max="120000" value="${config.timeoutMs}" placeholder="30000">
        <small class="field-hint">范围 1000-120000，默认 30000。</small>
      </div>
      <div class="field">
        <label for="model-max-tokens">Max tokens（最大 Token 数）</label>
        <input id="model-max-tokens" data-draft type="number" min="256" max="32768" value="${config.maxTokens}" placeholder="4096">
        <small class="field-hint">单次模型响应的上限，范围 256-32768。</small>
      </div>
    </div>
    <div class="field">
      <label for="model-api-key">API key（API 密钥）</label>
      <input id="model-api-key" data-draft type="password" autocomplete="off" placeholder="${config.hasApiKey ? '已安全保存；留空保持不变' : '输入模型网关的 API 密钥'}">
      <small class="field-hint">仅保存在 macOS 安全存储；留空不会覆盖已保存密钥。</small>
    </div>
    <label class="inline-actions"><input id="model-clear-key" data-draft type="checkbox"><span>删除已保存密钥</span></label>
    <div class="inline-actions" style="margin-top:12px">
      <button class="button primary" data-action="save-model">保存模型配置</button>
      <button class="button" data-action="test-model">测试连接</button>
    </div>
    <div class="notice" style="margin-top:12px">${escapeHtml(modelStatusText())}</div>
  `
}

function renderCredentialManager(): string {
  const selected = state.credentials.find(credential => credential.id === state.selectedCredentialId) ?? state.credentials[0]
  return `
    <div class="grid two">
      <div class="field">
        <label for="credential-id">Credential ID（凭据 ID）</label>
        <input id="credential-id" data-draft value="${escapeHtml(selected?.id ?? '')}" placeholder="例如：orders_api">
        <small class="field-hint">唯一标识，3-128 个字符；建议使用英文、数字、点、横线或下划线。</small>
      </div>
      <div class="field">
        <label for="credential-label">Label（显示名称）</label>
        <input id="credential-label" data-draft value="${escapeHtml(selected?.label ?? '')}" placeholder="例如：订单测试账号">
        <small class="field-hint">用于界面识别，1-160 个字符；可以填写中文。</small>
      </div>
    </div>
    <div class="grid three">
      <div class="field"><label for="credential-kind">Kind（凭据类型）</label>
        <select id="credential-kind" data-draft>
          <option value="bearer">Bearer token（Bearer 令牌）</option>
          <option value="header" ${selected?.kind === 'header' ? 'selected' : ''}>Custom header（自定义请求头）</option>
          <option value="cookie" ${selected?.kind === 'cookie' ? 'selected' : ''}>Cookie（Cookie 凭据）</option>
          <option value="basic" ${selected?.kind === 'basic' ? 'selected' : ''}>Basic Auth（基础认证）</option>
        </select>
        <small class="field-hint">Bearer 使用 Authorization；Cookie 和 Basic Auth 会按类型注入。</small>
      </div>
      <div class="field">
        <label for="credential-header">Header name（请求头名称）</label>
        <input id="credential-header" data-draft value="${escapeHtml(selected?.headerName ?? '')}" placeholder="例如：X-Api-Token">
        <small class="field-hint">仅“自定义请求头”需要填写；不能使用 Authorization 或 Cookie。</small>
      </div>
      <div class="field">
        <label for="credential-username">Basic username（基础认证用户名）</label>
        <input id="credential-username" data-draft value="${escapeHtml(selected?.username ?? '')}" placeholder="仅 Basic Auth 需要">
        <small class="field-hint">仅“基础认证”需要填写，不包含密码。</small>
      </div>
    </div>
    <div class="field">
      <label for="credential-secret">Secret（秘密值）</label>
      <input id="credential-secret" data-draft type="password" autocomplete="off" placeholder="${selected === undefined ? '输入 Token、Cookie、密码或 Header 值' : '已安全保存；留空则保持不变'}">
      <small class="field-hint">秘密值只在首次保存时输入，使用 macOS 安全存储加密，不会出现在项目、日志或报告中。</small>
    </div>
    ${state.credentials.length === 0 ? '' : `
      <div class="field"><label for="credential-select">Saved credential（已保存凭据）</label>
        <select id="credential-select" data-draft>
          ${state.credentials.map(credential => `<option value="${escapeHtml(credential.id)}" ${state.selectedCredentialId === credential.id ? 'selected' : ''}>${escapeHtml(credential.label)} · ${escapeHtml(credential.reference)}</option>`).join('')}
        </select>
      </div>
    `}
    <div class="inline-actions" style="margin-top:12px">
      <button class="button primary" data-action="save-credential">保存凭据</button>
      <button class="button" data-action="test-credential" ${selected === undefined ? 'disabled' : ''}>使用目标测试</button>
      <button class="button danger" data-action="delete-credential" ${selected === undefined ? 'disabled' : ''}>删除凭据</button>
    </div>
    <div class="notice" style="margin-top:10px">${escapeHtml(state.credentialMessage ?? '秘密值使用 macOS 安全存储加密，不会返回给界面渲染进程。')}</div>
  `
}

function renderAgentPlan(preview: AgentPlanPreview): string {
  return `
    <div class="inline-actions" style="justify-content:space-between">
      <span class="pill">${escapeHtml(preview.plan.schema_version)}</span>
      <span class="pill">${escapeHtml(preview.planSource === 'model' ? '模型计划（model plan）' : '确定性计划（deterministic plan）')}</span>
      <span class="status ${preview.validation.valid ? 'passed' : 'failed'}">${preview.validation.valid ? '校验通过（validated）' : '计划无效（invalid）'}</span>
    </div>
    <p class="muted">模型状态（Model）：${escapeHtml(preview.modelStatus)}${preview.modelError === undefined ? '' : ` · ${escapeHtml(preview.modelError)}`}</p>
    <p class="mono muted">${escapeHtml(preview.planHash)}</p>
    <div class="notice">${escapeHtml(preview.riskSummary)}</div>
    <div class="timeline" style="margin-top:14px">
      ${preview.plan.steps.map(step => `
        <div class="timeline-item">
          <div class="inline-actions" style="justify-content:space-between">
            <strong>${escapeHtml(step.title)}</strong>
            <span class="pill ${step.risk.side_effects ? 'risk' : ''}">${escapeHtml(step.tool)}</span>
          </div>
          <div class="mono muted">${escapeHtml(JSON.stringify(step.arguments))}</div>
          <div>${escapeHtml(step.risk.reasons.join(' '))}</div>
          <div class="muted">验收：${escapeHtml(step.acceptance_criteria.join('; '))}</div>
        </div>
      `).join('')}
    </div>
    ${preview.validation.valid ? `
      <label class="inline-actions" style="margin-top:14px">
        <input id="agent-confirm" type="checkbox" ${state.agentConfirmed ? 'checked' : ''}>
        <span>我已确认目标、参数、授权范围和副作用风险</span>
      </label>
      <div class="inline-actions" style="margin-top:14px">
        <button class="button primary" data-action="start-agent" ${state.agentConfirmed ? '' : 'disabled'}>确认并执行真实任务</button>
      </div>
    ` : '<div class="notice" style="margin-top:14px">计划校验未通过，禁止执行。</div>'}
  `
}

function renderAgentTaskSummary(): string {
  if (state.agentTask === undefined) return ''
  return `<div class="notice" style="margin-top:14px">Agent task ${escapeHtml(state.agentTask.state.task_id)}: <strong>${escapeHtml(state.agentTask.state.status)}</strong></div>`
}

function renderAgentProgress(view: AgentTaskView): string {
  const stateValue = view.state
  return `
    <section class="card">
      <div class="inline-actions" style="justify-content:space-between">
        <h3>执行进度</h3>
        <span class="status ${escapeHtml(stateValue.status)}">${escapeHtml(stateValue.status)}</span>
      </div>
      <div class="timeline">
        ${stateValue.steps.map(step => `
          <div class="timeline-item ${escapeHtml(step.status)}">
            <strong>${escapeHtml(step.title)}</strong>
            <div class="mono muted">${escapeHtml(step.status)} ${step.run_ids?.length ? `· ${escapeHtml(step.run_ids.join(', '))}` : ''}</div>
            ${step.error === undefined ? '' : `<div>${escapeHtml(step.error)}</div>`}
          </div>
        `).join('')}
      </div>
      ${renderAgentToolCalls(stateValue)}
      ${isActive(stateValue.status) ? '<button class="button danger" data-action="cancel-agent">停止 Agent 任务</button>' : ''}
      ${renderAgentAnalysis(view)}
    </section>
  `
}

function renderAgentToolCalls(stateValue: AgentTaskView['state']): string {
  return `
    <p class="eyebrow" style="margin-top:18px">工具调用（Tool calls）</p>
    <div class="timeline">
      ${stateValue.tool_calls.length === 0 ? '<p class="muted">尚无工具调用。</p>' : stateValue.tool_calls.map(call => `
        <div class="timeline-item ${escapeHtml(call.status)}">
          <div class="inline-actions" style="justify-content:space-between">
            <strong>${escapeHtml(call.tool)}</strong>
            <span class="pill ${call.side_effects ? 'risk' : ''}">${call.side_effects ? '有副作用（side effects）' : '本地操作（local）'}</span>
          </div>
          <div class="mono muted">${escapeHtml(call.status)} · ${escapeHtml(formatTime(call.started_at))}</div>
          ${call.error === undefined ? '' : `<div>${escapeHtml(call.error)}</div>`}
        </div>
      `).join('')}
    </div>
  `
}

function renderAgentAnalysis(view: AgentTaskView): string {
  const analysis = view.analysis ?? view.state.failure_analysis
  if (analysis === undefined) return ''
  return `
    <p class="eyebrow" style="margin-top:18px">证据分析（Evidence analysis）</p>
    <div class="grid three">
      <div><h3>事实</h3>${analysis.facts.map(item => `<p>${escapeHtml(item)}</p>`).join('')}</div>
      <div><h3>有证据的推断</h3>${analysis.inferences.map(item => `<p>${escapeHtml(item.statement)}<br><span class="mono muted">${escapeHtml(item.evidence)}</span></p>`).join('')}</div>
      <div><h3>待验证假设</h3>${analysis.hypotheses.map(item => `<p>${escapeHtml(item.statement)}<br><span class="mono muted">${escapeHtml(item.verification)}</span></p>`).join('')}</div>
    </div>
    ${analysis.model_status === 'unavailable' ? `<div class="notice">模型增强不可用：${escapeHtml(analysis.model_error ?? 'unknown')}</div>` : ''}
  `
}

type ConfigOperation = 'project' | 'replay' | 'performance'

function currentConfigOperation(): ConfigOperation {
  if (state.view === 'api') return 'replay'
  if (state.view === 'performance') return 'performance'
  return 'project'
}

function renderConfigForm(): string {
  const config = state.project?.config
  if (config === undefined) return ''
  const operation = currentConfigOperation()
  const operationLabel = operation === 'replay'
    ? 'API 回放'
    : operation === 'performance'
      ? '负载测试'
      : '项目基础配置'
  return `
    <details class="card" id="config-details">
      <summary style="cursor:pointer"><strong>项目配置</strong> <span class="muted">当前：${operationLabel}</span></summary>
      <div id="config-form" style="margin-top:18px">
        <p class="muted" style="margin-top:0">仅显示当前操作需要的配置，保存后生效。</p>
        <div class="grid two">
          <div>
            <div class="field">
              <label for="cfg-base-url">目标地址 *</label>
              <div class="field-with-action">
                <input id="cfg-base-url" data-draft value="${escapeHtml(config.target.baseUrl)}" placeholder="http://10.16.30.53">
                <button type="button" class="button subtle" data-action="use-target-origin">填入目标源</button>
              </div>
              <small class="field-hint">已授权的测试环境地址。</small>
            </div>
            <div class="field">
              <label for="cfg-origins">允许访问的源 *</label>
              <textarea id="cfg-origins" data-draft placeholder="http://10.16.30.53">${escapeHtml(config.target.allowedOrigins.join('\n'))}</textarea>
              <small class="field-hint">每行一个，必须包含目标源。</small>
            </div>
            ${operation === 'replay' ? `<div class="field">
              <label for="cfg-credential">安全凭据</label>
              <select id="cfg-credential" data-draft>
                <option value="">不使用凭据</option>
                ${state.credentials.map(credential => `<option value="${escapeHtml(credential.reference)}" ${(config.credentialRef ?? state.pendingCredentialRef) === credential.reference ? 'selected' : ''}>${escapeHtml(credential.label)}</option>`).join('')}
              </select>
              <small class="field-hint">接口需要登录时选择。</small>
            </div>` : ''}
          </div>
          <div>
            <div class="field">
              <label for="cfg-auth-scope">授权范围 *</label>
              <textarea id="cfg-auth-scope" data-draft placeholder="环境 / 账号 / 数据范围 / 操作 / 有效期">${escapeHtml(config.authorization.scope)}</textarea>
              <small class="field-hint">环境、账号、数据范围、操作和有效期。</small>
              <div class="inline-actions"><button type="button" class="button subtle" data-action="fill-auth-scope-template">填入模板</button></div>
            </div>
            <label class="inline-actions"><input id="cfg-auth-confirmed" data-draft type="checkbox" ${config.authorization.confirmed ? 'checked' : ''}><span>目标、账号和数据范围已获授权</span></label>
            <small class="field-hint">执行真实请求前必须确认。</small>
          </div>
        </div>
        ${operation === 'replay' ? `
          <div style="margin-top:20px;border-top:1px solid rgba(31,28,24,.12);padding-top:16px">
            <p class="eyebrow">回放设置</p>
            <div class="grid two">
              <div>
                <div class="field">
                  <label for="cfg-paths">路径白名单</label>
                  <textarea id="cfg-paths" data-draft placeholder="/api/**&#10;/health">${escapeHtml(config.target.allowedPaths.join('\n'))}</textarea>
                  <small class="field-hint">每行一个路径；留空不限制。</small>
                </div>
                <div class="field">
                  <label for="cfg-headers">环境请求头（JSON）</label>
                  <textarea id="cfg-headers" data-draft placeholder="{&quot;X-Test-Environment&quot;: &quot;staging&quot;}">${escapeHtml(JSON.stringify(config.environment.headers, null, 2))}</textarea>
                  <small class="field-hint">仅填非敏感请求头；认证走凭据。</small>
                </div>
              </div>
              <div>
                <div class="grid two">
                  <div class="field">
                    <label for="cfg-api-timeout">超时（毫秒）</label>
                    <input id="cfg-api-timeout" data-draft type="number" min="100" step="100" value="${config.api.timeoutMs}" placeholder="5000">
                  </div>
                  <div class="field">
                    <label for="cfg-api-concurrency">并发数</label>
                    <input id="cfg-api-concurrency" data-draft type="number" min="1" max="10" value="${config.api.concurrency}" placeholder="1">
                    <small class="field-hint">1–10；有关联变量时自动串行。</small>
                  </div>
                </div>
                <div class="field">
                  <label for="cfg-assertions">断言（JSON）</label>
                  <textarea id="cfg-assertions" data-draft placeholder="[{&quot;index&quot;: 0, &quot;status&quot;: 200}]">${escapeHtml(JSON.stringify(config.api.assertions, null, 2))}</textarea>
                  <small class="field-hint">按 HAR 请求序号校验响应。</small>
                </div>
                <div class="field">
                  <label for="cfg-correlations">关联变量（JSON）</label>
                  <textarea id="cfg-correlations" data-draft placeholder="[{&quot;sourceIndex&quot;: 0, &quot;jsonPath&quot;: &quot;$.token&quot;, &quot;variableName&quot;: &quot;token&quot;, &quot;targetIndexes&quot;: [1]}]">${escapeHtml(JSON.stringify(config.correlations, null, 2))}</textarea>
                  <small class="field-hint">从响应提取变量，注入后续请求。</small>
                </div>
              </div>
            </div>
          </div>
        ` : ''}
        ${operation === 'performance' ? `
          <div style="margin-top:20px;border-top:1px solid rgba(31,28,24,.12);padding-top:16px">
            <p class="eyebrow">负载测试设置</p>
            <div class="grid two">
              <div>
                <div class="grid two">
                  <div class="field">
                    <label for="cfg-engine">执行引擎</label>
                    <select id="cfg-engine" data-draft><option value="k6" ${config.performance.engine === 'k6' ? 'selected' : ''}>k6</option><option value="jmeter" ${config.performance.engine === 'jmeter' ? 'selected' : ''}>JMeter</option></select>
                  </div>
                  <div class="field">
                    <label for="cfg-vus">虚拟用户数</label>
                    <input id="cfg-vus" data-draft type="number" min="1" max="100" value="${config.performance.vus}" placeholder="1">
                  </div>
                  <div class="field">
                    <label for="cfg-duration">持续时间</label>
                    <input id="cfg-duration" data-draft value="${escapeHtml(config.performance.duration)}" placeholder="30s 或 2m">
                    <small class="field-hint">留空时按迭代次数执行。</small>
                  </div>
                  <div class="field">
                    <label for="cfg-iterations">迭代次数</label>
                    <input id="cfg-iterations" data-draft type="number" min="1" value="${config.performance.iterations}" placeholder="1">
                  </div>
                </div>
                <div class="field">
                  <label for="cfg-engine-timeout">引擎超时（毫秒）</label>
                  <input id="cfg-engine-timeout" data-draft type="number" min="100" step="1000" value="${config.performance.timeoutMs}" placeholder="60000">
                </div>
              </div>
              <div>
                <div id="cfg-k6-options" ${config.performance.engine === 'k6' ? '' : 'hidden'}>
                  <div class="field">
                    <label for="cfg-k6-path">k6 路径</label>
                    <input id="cfg-k6-path" data-draft value="${escapeHtml(config.performance.enginePaths.k6 ?? '')}" placeholder="/usr/local/bin/k6">
                    <small class="field-hint">PATH 中找不到时填写。</small>
                  </div>
                  <div class="field">
                    <label for="cfg-assertions">断言（JSON）</label>
                    <textarea id="cfg-assertions" data-draft placeholder="[{&quot;index&quot;: 0, &quot;status&quot;: 200}]">${escapeHtml(JSON.stringify(config.api.assertions, null, 2))}</textarea>
                    <small class="field-hint">由 k6 校验测试结果。</small>
                  </div>
                </div>
                <div id="cfg-jmeter-options" ${config.performance.engine === 'jmeter' ? '' : 'hidden'}>
                  <div class="field">
                    <label for="cfg-jmeter-path">JMeter 路径</label>
                    <input id="cfg-jmeter-path" data-draft value="${escapeHtml(config.performance.enginePaths.jmeter ?? '')}" placeholder="/path/to/jmeter/bin/jmeter">
                    <small class="field-hint">PATH 中找不到时填写。</small>
                  </div>
                </div>
                <div class="field">
                  <label for="cfg-correlations">关联变量（JSON）</label>
                  <textarea id="cfg-correlations" data-draft placeholder="[{&quot;sourceIndex&quot;: 0, &quot;jsonPath&quot;: &quot;$.token&quot;, &quot;variableName&quot;: &quot;token&quot;, &quot;targetIndexes&quot;: [1]}]">${escapeHtml(JSON.stringify(config.correlations, null, 2))}</textarea>
                  <small class="field-hint">从响应提取变量，注入后续请求。</small>
                </div>
              </div>
            </div>
          </div>
        ` : ''}
        <button id="save-config-button" class="button primary" data-action="save-config" style="margin-top:14px">保存并校验配置</button>
      </div>
    </details>
  `
}
function modelNotice(): string {
  if (!state.modelConfig.encryptionAvailable) return '系统安全存储不可用；不能保存模型密钥。'
  if (state.modelConfig.baseUrl.length === 0 || state.modelConfig.model.length === 0) return '未配置模型网关；将使用确定性计划并明确标记为不可用（unavailable）。'
  return '模型输出仅用于生成候选计划，必须通过 schema、工具白名单和人工确认后才会执行。'
}

function modelStatusText(): string {
  const last = state.modelConfig.lastConnection
  const connection = last === undefined
    ? '尚未测试连接'
    : `${last.status === 'available' ? '连接可用' : '连接不可用'} · ${escapeHtml(last.checked_at)}${last.error === undefined ? '' : ` · ${escapeHtml(last.error)}`}`
  return `${connection} · API 密钥（Key）${state.modelConfig.hasApiKey ? '已保存' : '未设置'} · 安全存储（Secure storage）${state.modelConfig.encryptionAvailable ? '可用' : '不可用'}${state.modelMessage === undefined ? '' : ` · ${state.modelMessage}`}`
}

function metric(label: string, value: string, detail: string): string {
  return `<article class="card metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></article>`
}

function bindDelegatedInput(): void {
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    const target = event.target
    if (!(target instanceof HTMLInputElement) || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
    const action = target.id.startsWith('cfg-')
      ? 'save-config'
      : target.id.startsWith('model-')
        ? 'save-model'
        : target.id.startsWith('credential-')
          ? 'save-credential'
          : undefined
    if (action === undefined) return
    event.preventDefault()
    const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
    if (button !== null && !button.disabled && !busyActions.has(action)) button.click()
  })
  document.addEventListener('input', event => {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    if (target.id.length !== 0) clearFieldError(target)
    if (target.id === 'agent-goal') state.agentGoal = target.value
    if (target.id === 'agent-engine') state.agentEngine = target.value as EngineKind | 'none'
    if (target.id === 'ui-case-json') state.uiCaseText = target.value
    if (target.id === 'request-filter') {
      state.requestFilter = target.value
      render()
    }
  })
  document.addEventListener('change', event => {
    const target = event.target as HTMLInputElement
    if (target.id.length !== 0) clearFieldError(target)
    if (target.id === 'cfg-engine') {
      document.querySelector<HTMLElement>('#cfg-k6-options')?.toggleAttribute('hidden', target.value !== 'k6')
      document.querySelector<HTMLElement>('#cfg-jmeter-options')?.toggleAttribute('hidden', target.value !== 'jmeter')
    }
    if (target.dataset.requestSelect !== undefined) {
      const order = Number(target.dataset.requestSelect)
      const selected = new Set(state.selectedRequestOrders)
      if (target.checked) selected.add(order)
      else selected.delete(order)
      state.selectedRequestOrders = [...selected].sort((left, right) => left - right)
      render()
      return
    }
    if (target.id === 'request-select-all') {
      const selected = new Set(state.selectedRequestOrders)
      const visible = (state.project?.requests ?? []).filter(request => requestMatchesFilter(request, state.requestFilter.trim()))
      for (const request of visible) {
        if (target.checked) selected.add(request.order)
        else selected.delete(request.order)
      }
      state.selectedRequestOrders = [...selected].sort((left, right) => left - right)
      render()
      return
    }
    if (target.id === 'agent-confirm') state.agentConfirmed = target.checked
    if (target.id === 'agent-confirm') render()
    if (target.id === 'credential-select') {
      state.selectedCredentialId = target.value
      state.credentialMessage = undefined
      render(false)
    }
  })
}

function bindActions(): void {
  document.querySelectorAll<HTMLElement>('[data-view]').forEach(element => {
    element.addEventListener('click', () => {
      state.view = element.dataset.view ?? 'overview'
      if (state.view === 'runs' && state.selectedTaskId === undefined) {
        state.selectedTaskId = state.tasks[0]?.task_id
        if (state.selectedTaskId !== undefined) void loadTask(state.selectedTaskId)
      }
      render()
    })
  })
  document.querySelectorAll<HTMLElement>('[data-request]').forEach(element => {
    element.addEventListener('click', event => {
      if (event.target instanceof HTMLInputElement) return
      const order = Number(element.dataset.request)
      state.selectedRequest = state.project?.requests.find(request => request.order === order)
      render()
    })
  })
  const requestCheckboxes = [...document.querySelectorAll<HTMLInputElement>('[data-request-select]')]
  const selectAll = document.querySelector<HTMLInputElement>('#request-select-all')
  if (selectAll !== null) {
    const checked = requestCheckboxes.filter(input => input.checked).length
    selectAll.indeterminate = checked > 0 && checked < requestCheckboxes.length
  }
  document.querySelectorAll<HTMLElement>('[data-task]').forEach(element => {
    element.addEventListener('click', () => {
      const taskId = element.dataset.task
      if (taskId !== undefined) void loadTask(taskId)
    })
  })
  document.querySelectorAll<HTMLElement>('[data-ui-case]').forEach(element => {
    element.addEventListener('click', () => {
      if (element.dataset.uiCase !== undefined) void loadUiCase(element.dataset.uiCase)
    })
  })
  document.querySelectorAll<HTMLElement>('[data-asset]').forEach(element => {
    element.addEventListener('click', () => {
      if (element.dataset.asset !== undefined) void loadAsset(element.dataset.asset)
    })
  })
  document.querySelectorAll<HTMLElement>('[data-code-analysis]').forEach(element => {
    element.addEventListener('click', () => {
      if (element.dataset.codeAnalysis !== undefined) void loadCodeAnalysis(element.dataset.codeAnalysis)
    })
  })
  document.querySelectorAll<HTMLElement>('[data-coverage]').forEach(element => {
    element.addEventListener('click', () => {
      if (element.dataset.coverage !== undefined) void loadCoverage(element.dataset.coverage)
    })
  })
  document.querySelectorAll<HTMLElement>('[data-action]').forEach(element => {
    element.addEventListener('click', () => {
      const action = element.dataset.action ?? ''
      if (busyActions.has(action)) return
      void runBusyAction(element, action)
    })
  })
}

const busyActions = new Set<string>()

async function runBusyAction(element: HTMLElement, action: string): Promise<void> {
  busyActions.add(action)
  const button = element instanceof HTMLButtonElement ? element : undefined
  const previousLabel = button?.textContent ?? ''
  if (button !== undefined) {
    button.disabled = true
    button.dataset.busy = 'true'
    button.textContent = '处理中…'
  }
  try {
    await handleAction(action, element.dataset)
  } finally {
    busyActions.delete(action)
    if (button !== undefined && document.body.contains(button)) {
      button.disabled = false
      delete button.dataset.busy
      button.textContent = previousLabel
    }
  }
}

async function handleAction(action: string, data: DOMStringMap): Promise<void> {
  try {
    if (action === 'save-model') {
      const clearKey = document.querySelector<HTMLInputElement>('#model-clear-key')?.checked ?? false
      const key = document.querySelector<HTMLInputElement>('#model-api-key')?.value ?? ''
      state.modelConfig = await window.testAgent.saveModelConfig({
        provider: inputValue('model-provider') as PublicModelConfig['provider'],
        baseUrl: inputValue('model-base-url').trim(),
        model: inputValue('model-name').trim(),
        chatPath: inputValue('model-chat-path').trim() || undefined,
        timeoutMs: Number(inputValue('model-timeout')),
        maxTokens: Number(inputValue('model-max-tokens')),
        apiKey: clearKey ? null : key.trim().length === 0 ? undefined : key,
      })
      state.modelMessage = '模型配置已保存。'
      render(false)
    } else if (action === 'test-model') {
      const result = await window.testAgent.testModelConnection()
      state.modelConfig = await window.testAgent.getModelConfig()
      state.modelMessage = result.status === 'available' ? '模型网关连接可用。' : `模型网关不可用：${result.error ?? 'unknown'}`
      render()
    } else if (action === 'save-credential') {
      const id = inputValue('credential-id').trim()
      const label = inputValue('credential-label').trim()
      const kind = inputValue('credential-kind') as PublicCredential['kind']
      const headerName = inputValue('credential-header').trim()
      const username = inputValue('credential-username').trim()
      const secret = inputValue('credential-secret')
      const issue = credentialInputIssue({ id, label, kind, headerName, username, secret })
      if (issue !== undefined) {
        toast(issue.message, true)
        focusField(issue.focusId)
        return
      }
      const saved = await window.testAgent.saveCredential({
        ...id.length === 0 ? {} : { id },
        label,
        kind,
        ...headerName.length === 0 ? {} : { headerName },
        ...username.length === 0 ? {} : { username },
        ...secret.length === 0 ? {} : { secret },
      })
      state.credentials = await window.testAgent.listCredentials()
      state.selectedCredentialId = saved.id
      state.pendingCredentialRef = saved.reference
      state.credentialMessage = `已保存 ${saved.reference}，并已在项目配置中选中；请点击“保存并校验配置”后生效。`
      render(false)
    } else if (action === 'test-credential') {
      const selected = state.credentials.find(credential => credential.id === state.selectedCredentialId) ?? state.credentials[0]
      if (selected === undefined) throw new Error('save a credential first')
      const result = await window.testAgent.testCredential(selected.reference)
      state.credentialMessage = result.status === 'available'
        ? `凭据测试已到达目标（HTTP ${result.httpStatus ?? '无状态码'}）。`
        : result.status === 'unauthorized'
          ? '目标拒绝了该凭据（HTTP 401/403）。'
          : `凭据测试不可用：${result.error ?? '未知错误'}`
      render()
    } else if (action === 'delete-credential') {
      const selected = state.credentials.find(credential => credential.id === state.selectedCredentialId) ?? state.credentials[0]
      if (selected === undefined) throw new Error('select a credential first')
      await window.testAgent.deleteCredential(selected.id)
      state.credentials = await window.testAgent.listCredentials()
      state.selectedCredentialId = state.credentials[0]?.id
      state.credentialMessage = `已删除凭据 ${selected.reference}。`
      render(false)
    } else if (action === 'create-project') {
      const name = await requestText({
        title: '创建测试项目',
        description: '先输入项目名称，再选择新项目所在目录。项目文件会创建在所选目录下的独立文件夹中。',
        label: '项目名称',
        placeholder: '例如：orders-local',
        confirmLabel: '选择目录并创建',
        maxLength: 80,
        validate: validateProjectName,
      })
      if (name === undefined) return
      const project = await window.testAgent.createProject({ name })
      if (project !== null) await adoptProject(project)
    } else if (action === 'open-project') {
      const project = await window.testAgent.openProject().catch((error: unknown) => {
        const message = (error as Error).message
        if (message.includes('project.json')) {
          throw new Error('所选目录不是 Test Agent 项目：缺少 project.json。请选择包含 project.json 的项目目录，或点击“创建测试项目”。')
        }
        throw error
      })
      if (project !== null) await adoptProject(project)
    } else if (action === 'import-har') {
      const project = await window.testAgent.importHar()
      if (project !== null) await adoptProject(project)
    } else if (action === 'use-target-origin') {
      const baseUrl = inputValue('cfg-base-url').trim()
      const origin = targetOrigin(baseUrl)
      if (origin === undefined) {
        revealProjectConfig({
      message: '请先填写有效的 Target base URL（http/https 绝对地址），再填入目标 origin。',
      focusId: 'cfg-base-url',
      hint: '必填：已授权的测试环境地址（http/https）',
    })
        return
      }
      const origins = lines('cfg-origins')
      if (!origins.includes(origin)) {
        const textarea = document.querySelector<HTMLTextAreaElement>('#cfg-origins')
        if (textarea !== null) textarea.value = [...origins, origin].join('\n')
        toast(`已将 ${origin} 加入 Allowed origins；请保存配置。`)
      } else {
        toast(`${origin} 已在 Allowed origins 中。`)
      }
    } else if (action === 'fill-auth-scope-template') {
      const textarea = document.querySelector<HTMLTextAreaElement>('#cfg-auth-scope')
      if (textarea === null) return
      if (textarea.value.trim().length > 0) {
        toast('授权范围已有内容。请直接补充或修改，模板不会覆盖现有内容。')
        textarea.focus()
        return
      }
      textarea.value = AUTH_SCOPE_TEMPLATE
      textarea.focus()
      toast('已填入模板。请把每一行的“请填写”替换为实际授权信息后再保存。')
    } else if (action === 'save-config') {
      const input = collectConfig()
      const issue = configInputIssue(input)
      if (issue !== undefined) {
        revealProjectConfig(issue)
        return
      }
      const project = await window.testAgent.saveConfig(input)
      await adoptProject(project)
      toast('项目配置已校验并保存')
    } else if (action === 'select-visible-requests') {
      const selected = new Set(state.selectedRequestOrders)
      const visible = (state.project?.requests ?? []).filter(request => requestMatchesFilter(request, state.requestFilter.trim()))
      for (const request of visible) selected.add(request.order)
      state.selectedRequestOrders = [...selected].sort((left, right) => left - right)
      render()
    } else if (action === 'clear-request-selection') {
      state.selectedRequestOrders = []
      render()
    } else if (action === 'start-replay') {
      if (!ensureExecutionTargetReady()) return
      const requests = state.project?.requests ?? []
      const selected = new Set(state.selectedRequestOrders)
      const requestOrders = requests.filter(request => selected.has(request.order)).map(request => request.order)
      if (requestOrders.length === 0) {
        toast('请至少选择一条 HAR 请求后再执行回放。', true)
        return
      }
      const task = await window.testAgent.startReplay(
        requestOrders.length === requests.length ? undefined : { requestOrders },
      )
      await openTask(task.task_id)
    } else if (action === 'start-performance') {
      if (!ensureExecutionTargetReady()) return
      const config = state.project?.config
      if (config === undefined) throw new Error('no project is open')
      const task = await window.testAgent.startPerformance({ engine: config.performance.engine })
      await openTask(task.task_id)
    } else if (action === 'generate-k6') {
      state.script = await window.testAgent.generateScript('k6')
      render()
      toast(`k6 脚本已保存：${state.script.path}`)
    } else if (action === 'generate-jmeter') {
      state.script = await window.testAgent.generateScript('jmeter')
      render()
      toast(`JMeter 脚本已保存：${state.script.path}`)
    } else if (action === 'open-script' && state.script !== undefined) {
      await window.testAgent.openArtifact(state.script.path)
    } else if (action === 'choose-engine') {
      const engine = data.engine as EngineKind
      const path = await window.testAgent.chooseEngineExecutable(engine)
      if (path !== null) {
        const input = document.querySelector<HTMLInputElement>(engine === 'k6' ? '#cfg-k6-path' : '#cfg-jmeter-path')
        if (input !== null) input.value = path
        toast(`已选择 ${engine} 可执行文件，保存配置后生效`)
      }
    } else if (action === 'refresh-tasks') {
      state.tasks = await window.testAgent.listTasks()
      if (state.selectedTaskId !== undefined) state.selectedTask = await window.testAgent.getTask(state.selectedTaskId)
      render()
    } else if (action === 'open-artifact') {
      if (data.path !== undefined) await window.testAgent.openArtifact(data.path)
    } else if (action === 'cancel-selected') {
      if (state.selectedTaskId === undefined) throw new Error('select a running task first')
      state.selectedTask = await window.testAgent.cancelTask(state.selectedTaskId)
      state.tasks = await window.testAgent.listTasks()
      render()
    } else if (action === 'preview-agent') {
      state.agentPreview = await window.testAgent.previewAgentPlan(state.agentGoal, state.agentEngine)
      state.agentConfirmed = false
      render()
    } else if (action === 'start-agent') {
      if (state.agentPreview === undefined) throw new Error('preview a plan first')
      state.agentTask = await window.testAgent.startAgent({
        plan: state.agentPreview.plan,
        planHash: state.agentPreview.planHash,
        confirmed: state.agentConfirmed,
      })
      state.selectedTaskId = state.agentTask.state.task_id
      state.agentConfirmed = false
      render()
    } else if (action === 'cancel-agent') {
      if (state.agentTask === undefined) return
      state.agentTask = await window.testAgent.cancelTask(state.agentTask.state.task_id)
        .then(result => result.agent === undefined ? state.agentTask! : { state: result.agent, analysis: result.agent.failure_analysis })
      state.tasks = await window.testAgent.listTasks()
      render()
    } else if (action === 'import-ui-recording') {
      const caseId = await requestText({
        title: '导入 UI 录制',
        description: '输入一个唯一用例 ID，然后选择 Playwright/浏览器录制 JSON 文件。',
        label: 'UI 用例 ID',
        placeholder: '例如：checkout-flow',
        confirmLabel: '选择录制文件',
        maxLength: 80,
        validate: value => /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(value)
          ? undefined
          : '用例 ID 需以字母或数字开头，只能包含字母、数字、点、横线和下划线。',
      })
      if (caseId === undefined) return
      const recording = await window.testAgent.chooseUiRecording()
      if (recording === null) return
      const summary = await window.testAgent.importUiRecording(recording, caseId)
      state.uiCases = await window.testAgent.listUiCases()
      await loadUiCase(summary.case_id)
      toast(`UI 用例已导入：${summary.case_id} v${summary.version}`)
    } else if (action === 'save-ui-case') {
      if (state.selectedUiCase === undefined) throw new Error('select a UI case first')
      const input = JSON.parse(state.uiCaseText) as UiCase
      input.version = state.selectedUiCase.version + 1
      input.updated_at = new Date().toISOString()
      const summary = await window.testAgent.saveUiCase(input, state.selectedUiCase.version)
      state.uiCases = await window.testAgent.listUiCases()
      await loadUiCase(summary.case_id)
      toast(`UI 用例已保存为 v${summary.version}`)
    } else if (action === 'run-ui-case') {
      if (state.selectedUiCase === undefined) throw new Error('select a UI case first')
      const task = await window.testAgent.runUiCase(state.selectedUiCase.case_id, state.selectedUiCase.version)
      await openTask(task.task_id)
    } else if (action === 'scan-assets') {
      state.assets = await window.testAgent.scanAssets()
      render()
      toast(`已登记 ${state.assets.length} 个测试资产`)
    } else if (action === 'execute-asset') {
      if (state.selectedAsset === undefined) throw new Error('select an asset first')
      const task = await window.testAgent.executeAsset(state.selectedAsset.asset_id)
      await openTask(task.task_id)
    } else if (action === 'compare-asset') {
      if (state.selectedAsset === undefined) throw new Error('select an asset first')
      state.assetComparison = await window.testAgent.compareAssetRuns(state.selectedAsset.asset_id)
      render()
    } else if (action === 'analyze-java-source' || action === 'analyze-java-war') {
      const path = action === 'analyze-java-source'
        ? await window.testAgent.chooseJavaSource()
        : await window.testAgent.chooseJavaArchive()
      if (path === null) return
      const result = await window.testAgent.analyzeCode(path)
      state.lastCodePath = path
      state.codeAnalyses = await window.testAgent.listCodeAnalyses()
      await loadCodeAnalysis(result.analysis.analysis_id)
      toast(`分析完成：${result.analysis.classes.length} classes / ${result.analysis.branches.length} branches`)
    } else if (action === 'choose-runtime-coverage') {
      const path = await window.testAgent.chooseRuntimeCoverage()
      if (path !== null) {
        state.runtimeCoveragePath = path
        render()
      }
    } else if (action === 'analyze-coverage') {
      if (state.selectedCode === undefined) throw new Error('select a code analysis first')
      state.selectedCoverage = await window.testAgent.analyzeCoverage(state.selectedCode.analysis_id, state.runtimeCoveragePath)
      state.coverageAnalyses = await window.testAgent.listCoverageAnalyses()
      render()
    } else if (action === 'execute-candidate') {
      if (state.selectedCoverage === undefined || data.candidate === undefined) throw new Error('select a candidate first')
      state.selectedCoverage = await window.testAgent.executeCoverageCandidate(state.selectedCoverage.analysis_id, data.candidate)
      state.coverageAnalyses = await window.testAgent.listCoverageAnalyses()
      state.tasks = await window.testAgent.listTasks()
      render()
    } else if (action === 'preview-code-agent') {
      if (state.selectedCode === undefined) throw new Error('select a code analysis first')
      if (state.lastCodePath === undefined) throw new Error('select the source/archive again before asking the Agent to explain a prior analysis')
      const goal = await requestText({
        title: '让 Agent 解释证据',
        description: '描述希望模型重点解释的内容。模型不可用时仍会生成确定性的计划与分析。',
        label: '分析目标',
        initialValue: '解释端点、分支、异常和动态调用风险，区分事实与待验证假设',
        confirmLabel: '生成计划',
        multiline: true,
        maxLength: 4000,
        validate: value => value.length === 0 ? '请输入分析目标。' : undefined,
      })
      if (goal === undefined) return
      state.agentPreview = await window.testAgent.previewCodeAgentPlan(state.lastCodePath, goal)
      state.agentConfirmed = false
      state.view = 'agent'
      render()
    }
  } catch (error) {
    toast((error as Error).message, true)
  }
}

function ensureExecutionTargetReady(): boolean {
  const config = state.project?.config
  if (config === undefined) {
    toast('请先打开或创建一个测试项目。', true)
    return false
  }

  const draftIssue = configDraftIssue(config)
  if (draftIssue !== undefined) {
    revealProjectConfig(draftIssue)
    return false
  }

  const baseUrl = config.target.baseUrl.trim()
  if (baseUrl.length === 0) {
    revealProjectConfig({
      message: '尚未配置 Target base URL。请填写已授权的非生产测试地址，并配置对应的 Allowed origins 后保存。',
      focusId: 'cfg-base-url',
      relatedIds: ['cfg-origins'],
      hint: '必填：已授权的非生产测试地址（http/https）',
    })
    return false
  }

  const origin = targetOrigin(baseUrl)
  if (origin === undefined) {
    revealProjectConfig({
      message: 'Target base URL 必须是有效的 http(s) 绝对地址，且不能包含凭据、查询参数或片段。',
      focusId: 'cfg-base-url',
      hint: '格式错误：需为 http(s) 绝对地址，不含账号密码、查询参数或 # 片段',
    })
    return false
  }
  if (!config.target.allowedOrigins.includes(origin)) {
    revealProjectConfig({
      message: `Allowed origins 必须包含目标 origin：${origin}`,
      focusId: 'cfg-origins',
      hint: `缺少目标源：${origin}`,
    })
    return false
  }
  if (!config.authorization.confirmed) {
    revealProjectConfig({
      message: '请确认测试环境、账号和数据范围均已获得授权，再勾选授权确认并保存配置。',
      focusId: 'cfg-auth-confirmed',
      relatedIds: config.authorization.scope.trim().length === 0 || config.authorization.scope.includes('请填写') ? ['cfg-auth-scope'] : [],
      hint: '缺少勾选：目标与测试范围已获授权',
    })
    return false
  }
  return true
}

function configDraftIssue(config: ProjectConfig): ConfigIssue | undefined {
  if (document.querySelector('#config-form') === null) return undefined
  let draft: SaveProjectConfigInput
  try {
    draft = collectConfig()
  } catch {
    return {
      message: '配置中有 JSON 格式错误，请修正后再保存。',
      focusId: 'cfg-assertions',
    }
  }

  const baseUrl = draft.target.baseUrl.trim()
  if (baseUrl.length === 0) {
    return { message: '请填写已授权的非生产 Target base URL。', focusId: 'cfg-base-url' }
  }
  const origin = targetOrigin(baseUrl)
  if (origin === undefined) {
    return {
      message: 'Target base URL 必须是有效的 http(s) 绝对地址，且不能包含凭据、查询参数或片段。',
      focusId: 'cfg-base-url',
    }
  }
  if (!draft.target.allowedOrigins.includes(origin)) {
    return { message: `Allowed origins 必须包含目标 origin：${origin}`, focusId: 'cfg-origins' }
  }
  const scopeBlank = draft.authorization.scope.trim().length === 0
  const scopeTemplate = draft.authorization.scope.includes('请填写')
  if (!draft.authorization.confirmed) {
    if (scopeBlank) {
      return {
        message: '请先填写 Authorization scope（环境、专用测试账号、数据范围、允许操作、授权有效期），再勾选授权确认。',
        focusId: 'cfg-auth-scope',
        relatedIds: ['cfg-auth-confirmed'],
        hint: '必填：环境 / 专用测试账号 / 数据范围 / 允许操作 / 授权有效期',
      }
    }
    if (scopeTemplate) {
      return {
        message: '授权范围仍是模板内容。请把每一处“请填写”替换为实际授权信息，再勾选授权确认。',
        focusId: 'cfg-auth-scope',
        relatedIds: ['cfg-auth-confirmed'],
        hint: '仍含“请填写”占位：替换为实际环境、账号、数据范围、操作和有效期',
      }
    }
    return {
      message: '请确认目标、测试账号和数据范围均已获得授权，再勾选授权确认。',
      focusId: 'cfg-auth-confirmed',
      hint: '缺少勾选：目标与测试范围已获授权',
    }
  }
  if (scopeBlank) {
    return {
      message: '请填写 Authorization scope：环境、专用测试账号、数据范围、允许操作和授权有效期。',
      focusId: 'cfg-auth-scope',
      hint: '必填：环境 / 专用测试账号 / 数据范围 / 允许操作 / 授权有效期',
    }
  }
  if (scopeTemplate) {
    return {
      message: '授权范围仍是模板内容，请把每一处“请填写”替换为实际授权信息。',
      focusId: 'cfg-auth-scope',
      hint: '仍含“请填写”占位：替换为实际环境、账号、数据范围、操作和有效期',
    }
  }

  const saved: SaveProjectConfigInput = {
    target: config.target,
    environment: config.environment,
    api: config.api,
    performance: config.performance,
    correlations: config.correlations,
    authorization: config.authorization,
    credentialRef: config.credentialRef,
  }
  if (JSON.stringify(draft) !== JSON.stringify(saved)) {
    return {
      message: '配置有尚未保存的修改。请先点击“保存并校验配置”，再执行真实请求。',
      focusId: 'save-config-button',
      hint: '先保存配置，再执行回放',
    }
  }
  return undefined
}

function configInputIssue(input: SaveProjectConfigInput): ConfigIssue | undefined {
  const baseUrl = input.target.baseUrl.trim()
  if (baseUrl.length > 0) {
    const origin = targetOrigin(baseUrl)
    if (origin === undefined) {
      return {
        message: 'Target base URL 必须是有效的 http(s) 绝对地址，且不能包含凭据、查询参数或片段。',
        focusId: 'cfg-base-url',
      }
    }
    if (!input.target.allowedOrigins.includes(origin)) {
      return {
        message: `Allowed origins 必须包含目标 origin：${origin}。可点击“填入目标 origin”自动补全。`,
        focusId: 'cfg-origins',
      }
    }
  }

  for (const allowed of input.target.allowedOrigins) {
    let origin: string
    try {
      origin = new URL(allowed).origin
    } catch {
      return { message: `Allowed origin 不是有效地址：${allowed}`, focusId: 'cfg-origins' }
    }
    if (origin !== allowed) {
      return {
        message: `Allowed origin 只能包含 scheme、host 和 port，不能带路径：${allowed}`,
        focusId: 'cfg-origins',
      }
    }
  }

  if (input.authorization.confirmed && input.authorization.scope.trim().length === 0) {
    return {
      message: '勾选“目标与测试范围已获授权”后，必须填写 Authorization scope。',
      focusId: 'cfg-auth-scope',
    }
  }
  if (input.authorization.confirmed && input.authorization.scope.includes('请填写')) {
    return {
      message: '请将 Authorization scope 模板中的“请填写”内容替换为实际测试环境、账号、数据和授权有效期。',
      focusId: 'cfg-auth-scope',
    }
  }
  return undefined
}

function credentialInputIssue(input: {
  id: string
  label: string
  kind: PublicCredential['kind']
  headerName: string
  username: string
  secret: string
}): { message: string; focusId: string } | undefined {
  if (input.id.length > 0 && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(input.id)) {
    return {
      message: 'Credential ID 需以字母或数字开头，长度为 3-128，只能包含字母、数字、点、横线和下划线。',
      focusId: 'credential-id',
    }
  }
  if (input.label.length < 1 || input.label.length > 160) {
    return { message: '请填写 Credential Label，长度为 1-160 个字符。', focusId: 'credential-label' }
  }
  if (input.kind === 'header' && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(input.headerName)) {
    return { message: 'Custom header 凭据必须填写合法的 Header name。', focusId: 'credential-header' }
  }
  if (input.kind === 'header' && /^(authorization|cookie|proxy-authorization)$/i.test(input.headerName)) {
    return {
      message: 'Authorization、Cookie 等敏感 Header 请选择对应的凭据类型，不要使用 Custom header。',
      focusId: 'credential-kind',
    }
  }
  if (input.kind === 'basic' && input.username.length === 0) {
    return { message: 'Basic Auth 凭据必须填写用户名。', focusId: 'credential-username' }
  }
  if (input.secret.length > 4096) {
    return { message: 'Secret 超长，最多允许 4096 个字符。', focusId: 'credential-secret' }
  }
  const existing = input.id.length > 0 && state.credentials.some(credential => credential.id === input.id)
  if (input.secret.length === 0 && !existing) {
    return {
      message: '新凭据必须填写 Secret；Secret 只会加密保存在系统安全存储中。',
      focusId: 'credential-secret',
    }
  }
  return undefined
}

function targetOrigin(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return undefined
  return parsed.origin
}

interface ConfigIssue {
  message: string
  focusId: string
  relatedIds?: string[]
  hint?: string
}

function focusField(id: string): void {
  const field = document.querySelector<HTMLElement>(`#${id}`)
  field?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  requestAnimationFrame(() => field?.focus())
}

function fieldContainer(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('.field')
    ?? element.closest<HTMLElement>('label.inline-actions')
    ?? element
}

function markFieldError(id: string, hint?: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`)
  if (element === null) return
  const container = fieldContainer(element)
  container.classList.remove('invalid')
  void container.offsetWidth
  container.classList.add('invalid')
  element.setAttribute('aria-invalid', 'true')
  container.querySelectorAll('.field-error-text').forEach(node => node.remove())
  if (hint !== undefined && hint.length > 0) {
    const text = document.createElement('small')
    text.className = 'field-error-text'
    text.textContent = hint
    container.append(text)
  }
}

function clearFieldError(element: HTMLElement): void {
  const container = fieldContainer(element)
  container.classList.remove('invalid')
  container.querySelectorAll('.field-error-text').forEach(node => node.remove())
  element.removeAttribute('aria-invalid')
}

function clearAllFieldErrors(): void {
  document.querySelectorAll<HTMLElement>('.invalid').forEach(container => {
    container.classList.remove('invalid')
    container.querySelectorAll('.field-error-text').forEach(node => node.remove())
    container.querySelectorAll('[aria-invalid]').forEach(element => element.removeAttribute('aria-invalid'))
  })
}

function revealProjectConfig(issue: ConfigIssue): void {
  toast(issue.message, true)
  clearAllFieldErrors()
  const details = document.querySelector<HTMLDetailsElement>('#config-details')
  if (details !== null) details.open = true
  for (const id of issue.relatedIds ?? []) markFieldError(id)
  markFieldError(issue.focusId, issue.hint)
  const focusElement = document.querySelector<HTMLElement>(`#${issue.focusId}`)
  focusElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  requestAnimationFrame(() => focusElement?.focus())
}

function collectConfig(): SaveProjectConfigInput {
  const current = state.project?.config
  if (current === undefined) throw new Error('no project is open')
  const operation = currentConfigOperation()
  const api = operation === 'replay'
    ? {
        timeoutMs: Number(inputValue('cfg-api-timeout')),
        concurrency: Number(inputValue('cfg-api-concurrency')),
        assertions: parseArray('cfg-assertions') as SaveProjectConfigInput['api']['assertions'],
      }
    : operation === 'performance'
      ? {
          ...current.api,
          assertions: parseArray('cfg-assertions') as SaveProjectConfigInput['api']['assertions'],
        }
      : current.api
  let performance = current.performance
  if (operation === 'performance') {
    const engine = inputValue('cfg-engine') as EngineKind
    const enginePaths = { ...current.performance.enginePaths }
    const executable = inputValue(`cfg-${engine === 'k6' ? 'k6' : 'jmeter'}-path`).trim()
    if (executable.length === 0) delete enginePaths[engine]
    else enginePaths[engine] = executable
    performance = {
      engine,
      vus: Number(inputValue('cfg-vus')),
      duration: inputValue('cfg-duration').trim(),
      iterations: Number(inputValue('cfg-iterations')),
      timeoutMs: Number(inputValue('cfg-engine-timeout')),
      enginePaths,
    }
  }
  return {
    target: {
      baseUrl: inputValue('cfg-base-url').trim(),
      allowedOrigins: lines('cfg-origins'),
      allowedPaths: operation === 'replay' ? lines('cfg-paths') : current.target.allowedPaths,
    },
    environment: {
      headers: operation === 'replay'
        ? parseObject('cfg-headers') as Record<string, string>
        : current.environment.headers,
    },
    api,
    performance,
    correlations: operation === 'replay' || operation === 'performance'
      ? parseArray('cfg-correlations') as ProjectConfig['correlations']
      : current.correlations,
    authorization: {
      confirmed: document.querySelector<HTMLInputElement>('#cfg-auth-confirmed')?.checked ?? false,
      scope: inputValue('cfg-auth-scope').trim(),
    },
    credentialRef: operation === 'replay'
      ? inputValue('cfg-credential').trim().length === 0 ? undefined : inputValue('cfg-credential').trim()
      : current.credentialRef,
  }
}

async function adoptProject(project: ProjectSnapshot): Promise<void> {
  const boot = await window.testAgent.bootstrap()
  state.project = project
  state.requestFilter = ''
  state.selectedRequest = undefined
  state.selectedRequestOrders = project.requests.map(request => request.order)
  state.tasks = boot.tasks
  state.engines = boot.engines
  state.uiCases = boot.uiCases
  state.assets = boot.assets
  state.codeAnalyses = boot.codeAnalyses
  state.coverageAnalyses = boot.coverageAnalyses
  state.credentials = boot.credentials
  state.selectedTask = undefined
  state.selectedTaskId = undefined
  state.logs = []
  state.selectedUiCase = undefined
  state.uiCaseText = ''
  state.selectedAsset = undefined
  state.assetHistory = undefined
  state.assetComparison = undefined
  state.selectedCode = undefined
  state.selectedCoverage = undefined
  state.lastCodePath = undefined
  state.runtimeCoveragePath = undefined
  state.pendingCredentialRef = undefined
  render(false)
}

async function loadUiCase(caseId: string): Promise<void> {
  const summary = state.uiCases.find(item => item.case_id === caseId)
  if (summary === undefined) throw new Error(`UI case not listed: ${caseId}`)
  const testCase = await window.testAgent.getUiCase(caseId, summary.version)
  state.selectedUiCase = summary
  state.uiCaseText = JSON.stringify(testCase, null, 2)
  render()
}

async function loadAsset(assetId: string): Promise<void> {
  state.selectedAsset = await window.testAgent.getAsset(assetId)
  state.assetHistory = await window.testAgent.assetHistory(assetId)
  state.assetComparison = undefined
  render()
}

async function loadCodeAnalysis(analysisId: string): Promise<void> {
  state.selectedCode = await window.testAgent.getCodeAnalysis(analysisId)
  state.selectedCoverage = undefined
  state.runtimeCoveragePath = undefined
  const related = state.coverageAnalyses.find(item => item.code_analysis_id === analysisId)
  if (related !== undefined) state.selectedCoverage = await window.testAgent.getCoverageAnalysis(related.analysis_id)
  render()
}

async function loadCoverage(analysisId: string): Promise<void> {
  state.selectedCoverage = await window.testAgent.getCoverageAnalysis(analysisId)
  render()
}

async function openTask(taskId: string): Promise<void> {
  state.selectedTaskId = taskId
  await loadTask(taskId)
  state.view = 'runs'
  render()
}

async function loadTask(taskId: string): Promise<void> {
  state.selectedTask = await window.testAgent.getTask(taskId)
  state.logs = await window.testAgent.taskLogs(taskId)
  state.selectedTaskId = taskId
  render()
}

function requestText(options: TextPromptOptions): Promise<string | undefined> {
  cancelActiveTextPrompt?.()

  return new Promise(resolve => {
    const previousOverflow = document.body.style.overflow
    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop'
    backdrop.setAttribute('role', 'presentation')

    const modal = document.createElement('section')
    modal.className = 'modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-labelledby', 'text-prompt-title')
    modal.setAttribute('aria-describedby', 'text-prompt-description')

    const title = document.createElement('h3')
    title.id = 'text-prompt-title'
    title.textContent = options.title

    const description = document.createElement('p')
    description.id = 'text-prompt-description'
    description.textContent = options.description

    const field = document.createElement('div')
    field.className = 'field'
    const label = document.createElement('label')
    label.htmlFor = 'text-prompt-input'
    label.textContent = options.label
    const input = document.createElement(options.multiline === true ? 'textarea' : 'input')
    input.id = 'text-prompt-input'
    input.value = options.initialValue ?? ''
    input.placeholder = options.placeholder ?? ''
    input.autocomplete = 'off'
    if (options.maxLength !== undefined) input.maxLength = options.maxLength
    if (input instanceof HTMLTextAreaElement) input.rows = 5
    field.append(label, input)

    const error = document.createElement('p')
    error.className = 'modal-error'
    error.setAttribute('role', 'alert')
    error.hidden = true

    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const cancelButton = document.createElement('button')
    cancelButton.type = 'button'
    cancelButton.id = 'text-prompt-cancel'
    cancelButton.className = 'button subtle'
    cancelButton.textContent = '取消'
    const confirmButton = document.createElement('button')
    confirmButton.type = 'button'
    confirmButton.id = 'text-prompt-confirm'
    confirmButton.className = 'button primary'
    confirmButton.textContent = options.confirmLabel ?? '确认'
    actions.append(cancelButton, confirmButton)

    modal.append(title, description, field, error, actions)
    backdrop.append(modal)

    let settled = false
    const finish = (value?: string): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', handleKeyDown)
      backdrop.remove()
      document.body.style.overflow = previousOverflow
      if (cancelActiveTextPrompt === cancel) cancelActiveTextPrompt = undefined
      resolve(value)
    }
    const cancel = (): void => finish()
    const submit = (): void => {
      const value = input.value.trim()
      const message = value.length === 0
        ? '此项不能为空。'
        : options.validate?.(value)
      if (message !== undefined) {
        error.textContent = message
        error.hidden = false
        input.focus()
        return
      }
      finish(value)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Enter' && (!(input instanceof HTMLTextAreaElement) || event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        submit()
      }
    }

    cancelButton.addEventListener('click', cancel)
    confirmButton.addEventListener('click', submit)
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) cancel()
    })
    document.addEventListener('keydown', handleKeyDown)
    document.body.append(backdrop)
    document.body.style.overflow = 'hidden'
    cancelActiveTextPrompt = cancel
    input.focus()
    input.select()
  })
}

function validateProjectName(value: string): string | undefined {
  const name = value.trim()
  if (name.length < 1 || name.length > 80) return '项目名称长度必须为 1 到 80 个字符。'
  if (/[\u0000-\u001f/\\]/.test(name)) return '项目名称不能包含控制字符、斜杠或反斜杠。'
  return undefined
}

function startPolling(): void {
  if (pollTimer !== undefined) return
  pollTimer = window.setInterval(() => {
    void refreshLiveState()
  }, 1500)
}

async function refreshLiveState(): Promise<void> {
  if (state.project === undefined) return
  try {
    const tasks = await window.testAgent.listTasks()
    state.tasks = tasks
    if (state.selectedTaskId !== undefined) {
      const selected = tasks.find(task => task.task_id === state.selectedTaskId)
      const previousStatus = state.selectedTask?.task.status
      // A replay can finish in well under one polling interval. Refresh on the
      // running -> terminal transition too, otherwise the UI stays stuck on the
      // last "running" snapshot and the final report is never shown.
      const statusChanged = selected !== undefined && previousStatus !== undefined && selected.status !== previousStatus
      if (selected !== undefined && (isActive(selected.status) || statusChanged)) {
        state.selectedTask = await window.testAgent.getTask(state.selectedTaskId)
        state.logs = await window.testAgent.taskLogs(state.selectedTaskId)
        if (statusChanged || state.view === 'runs' || state.view === 'performance') render()
        if (statusChanged && !isActive(selected.status)) notifyTaskFinished(state.selectedTask)
      }
    }
    if (state.agentTask !== undefined) {
      const activeAgent = state.tasks.find(task => task.task_id === state.agentTask?.state.task_id)
      if (activeAgent !== undefined && isActive(activeAgent.status)) {
        state.agentTask = await window.testAgent.getAgentTask(activeAgent.task_id)
        if (state.view === 'agent') render()
      } else if (activeAgent !== undefined && state.agentTask.state.status !== activeAgent.status) {
        state.agentTask = await window.testAgent.getAgentTask(activeAgent.task_id)
        if (state.view === 'agent') render()
      }
    }
  } catch {
    // Polling errors are surfaced by the next explicit action.
  }
}

function inputValue(id: string): string {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)?.value ?? ''
}

function lines(id: string): string[] {
  return inputValue(id).split('\n').map(value => value.trim()).filter(Boolean)
}

function parseObject(id: string): Record<string, unknown> {
  const parsed = JSON.parse(inputValue(id)) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${id} must be a JSON object`)
  return parsed as Record<string, unknown>
}

function parseArray(id: string): unknown[] {
  const parsed = JSON.parse(inputValue(id)) as unknown
  if (!Array.isArray(parsed)) throw new Error(`${id} must be a JSON array`)
  return parsed
}

function isEngineReport(report: NonNullable<TaskSnapshot['report']>): report is Extract<NonNullable<TaskSnapshot['report']>, { metrics: unknown }> {
  return 'metrics' in report
}

function isUiReport(report: NonNullable<TaskSnapshot['report']>): report is Extract<NonNullable<TaskSnapshot['report']>, { steps_total: number }> {
  return 'steps_total' in report
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'running'
}

function replayAuthFailures(report: TaskSnapshot['report']): number {
  if (report === undefined || !('requests' in report) || isEngineReport(report) || isUiReport(report)) return 0
  const replay = report as Extract<TaskSnapshot['report'], { requests: unknown[] }>
  return replay.requests.filter(request => request.error_kind === 'auth').length
}

function notifyTaskFinished(snapshot: TaskSnapshot): void {
  const task = snapshot.task
  const summary = task.result_summary
  const counts = summary === undefined ? '' : `（${summary.passed ?? 0}/${summary.total ?? 0} 通过）`
  const authFailures = replayAuthFailures(snapshot.report)
  if (authFailures > 0) {
    toast(`任务失败${counts}：${authFailures} 个请求被目标认证拒绝（HTTP 401/403）。请在凭据管理配置有效登录凭据并绑定到项目配置。`, true)
    return
  }
  if (task.status === 'passed') {
    toast(`任务完成${counts}，详情见运行记录。`)
    return
  }
  const label = task.status === 'timeout' ? '超时' : task.status === 'cancelled' ? '已取消' : '失败'
  toast(`任务${label}${counts}，详情见运行记录。`, true)
}

function formatTime(value: string): string {
  if (value.length === 0) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatMs(value: number | null): string {
  return value === null ? 'n/a' : `${round(value)} ms`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function viewTitle(): string {
  return ({
    overview: state.project?.config.name ?? '项目总览',
    api: '请求回放与断言',
    performance: '真实负载执行',
    ui: '真实浏览器自动化',
    assets: '统一测试资产',
    code: 'Java 证据与候选覆盖',
    runs: '运行历史与证据',
    agent: '受控测试编排',
  } as Record<string, string>)[state.view] ?? '项目总览'
}

function viewEyebrow(): string {
  return ({
    overview: 'Workspace / project',
    api: 'Deterministic / replay',
    performance: 'Engines / real execution',
    ui: 'Playwright / browser evidence',
    assets: 'Native formats / versioned metadata',
    code: 'Static evidence / measured coverage',
    runs: 'Evidence / history',
    agent: 'Plan / confirm / observe',
  } as Record<string, string>)[state.view] ?? 'Workspace'
}

function showFatal(error: unknown): void {
  app.innerHTML = `<main class="main"><section class="empty-state"><p class="eyebrow">Startup error</p><h3>工作台无法启动。</h3><p>${escapeHtml((error as Error).message)}</p></section></main>`
}

function toast(message: string, error = false): void {
  document.querySelector('.toast')?.remove()
  const element = document.createElement('div')
  element.className = `toast${error ? ' error' : ''}`
  element.setAttribute('role', error ? 'alert' : 'status')
  element.textContent = message
  document.body.append(element)
  setTimeout(() => element.remove(), 5200)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  } as Record<string, string>)[character] ?? character)
}
