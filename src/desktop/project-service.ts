import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseHar } from '../har/parser.ts'
import type { ParsedHar } from '../har/types.ts'
import type { AssertionConfig } from '../api/assertions.ts'
import type { CorrelationConfig } from '../generators/k6.ts'
import type { EngineKind } from '../engines/types.ts'
import {
  DESKTOP_LIMITS,
  PROJECT_SCHEMA_VERSION,
  type DesktopRequestView,
  type ProjectConfig,
  type ProjectSnapshot,
  type RecentProject,
  type SaveProjectConfigInput,
} from './types.ts'
import {
  assertDirectory,
  assertRegularFile,
  isSensitiveHeader,
  resolveInside,
  safeFileStem,
} from './security.ts'
import { cleanupStaleTemporaryFiles } from './temp-cleanup.ts'

const RECENT_LIMIT = 12

export interface ProjectServiceOptions {
  appDataDirectory: string
}

export class ProjectService {
  readonly appDataDirectory: string
  readonly recentPath: string
  private currentRoot: string | undefined

  constructor(options: ProjectServiceOptions) {
    this.appDataDirectory = options.appDataDirectory
    this.recentPath = join(this.appDataDirectory, 'recent-projects.json')
  }

  async initialize(): Promise<void> {
    await mkdir(this.appDataDirectory, { recursive: true })
  }

  get root(): string | undefined {
    return this.currentRoot
  }

  currentConfig(): ProjectConfig {
    if (this.currentRoot === undefined) throw new Error('no project is open')
    return this.asCurrentConfig
  }

  async create(name: string, parentDirectory: string): Promise<ProjectSnapshot> {
    const cleanName = validateProjectName(name)
    const parent = await assertDirectory(parentDirectory)
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'test-project'
    const projectRoot = await uniqueDirectory(parent, slug)
    await mkdir(projectRoot)
    await mkdir(join(projectRoot, 'har'), { recursive: true })
    await mkdir(join(projectRoot, 'scripts'), { recursive: true })
    await mkdir(join(projectRoot, 'output'), { recursive: true })
    await mkdir(join(projectRoot, '.test-agent', 'desktop-tasks'), { recursive: true })
    const now = new Date().toISOString()
    const config: ProjectConfig = {
      schema_version: PROJECT_SCHEMA_VERSION,
      project_id: randomUUID(),
      name: cleanName,
      created_at: now,
      updated_at: now,
      target: {
        baseUrl: '',
        allowedOrigins: [],
        allowedPaths: [],
      },
      environment: { headers: {} },
      api: {
        timeoutMs: 5000,
        concurrency: 1,
        assertions: [],
      },
      performance: {
        engine: 'k6',
        vus: 1,
        duration: '',
        iterations: 1,
        timeoutMs: 60_000,
        enginePaths: {},
      },
      correlations: [],
      authorization: {
        confirmed: false,
        scope: '',
      },
      credentialRef: undefined,
    }
    await this.writeConfig(projectRoot, config)
    return await this.open(projectRoot)
  }

  async open(projectRoot: string): Promise<ProjectSnapshot> {
    const canonical = await assertDirectory(projectRoot)
    const projectFile = resolveInside(canonical, 'project.json')
    const projectInfo = await stat(projectFile).catch((error: NodeJS.ErrnoException) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error('selected directory does not contain project.json; open an existing Test Agent project or create a new project')
    })
    if (!projectInfo.isFile()) {
      throw new Error('selected directory does not contain project.json; open an existing Test Agent project or create a new project')
    }
    const config = await this.readConfig(canonical)
    await cleanupStaleTemporaryFiles(canonical).catch(() => undefined)
    this.currentRoot = canonical
    await this.remember(canonical, config.name)
    return await this.snapshot(canonical, config)
  }

  async switchTo(projectRoot: string): Promise<ProjectSnapshot> {
    return await this.open(projectRoot)
  }

  async importHar(sourcePath: string): Promise<ProjectSnapshot> {
    const root = this.requireRoot()
    await assertRegularFile(sourcePath)
    const inputInfo = await stat(sourcePath)
    if (inputInfo.size > DESKTOP_LIMITS.maxHarBytes) {
      throw new Error(`HAR exceeds the ${DESKTOP_LIMITS.maxHarBytes} byte import limit`)
    }
    const raw = await readFile(sourcePath, 'utf8')
    const parsed = parseHar(raw, {
      maxBytes: DESKTOP_LIMITS.maxHarBytes,
      maxEntries: DESKTOP_LIMITS.maxRequests,
      maxBodyBytes: 1024 * 1024,
    })
    const fileName = `${timestamp()}-${safeFileStem(basename(sourcePath))}.har`
    const relativePath = join('har', fileName)
    const destination = resolveInside(root, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, `${JSON.stringify(toSanitizedHar(parsed), null, 2)}\n`, { mode: 0o600 })
    const config = this.asCurrentConfig
    config.har_file = relativePath
    config.updated_at = new Date().toISOString()
    await this.writeConfig(root, config)
    return await this.snapshot(root, config)
  }

  async saveConfig(input: SaveProjectConfigInput): Promise<ProjectSnapshot> {
    const root = this.requireRoot()
    const previous = this.asCurrentConfig
    const validated = validateConfigInput(input)
    const next: ProjectConfig = {
      ...previous,
      ...validated,
      updated_at: new Date().toISOString(),
    }
    await this.writeConfig(root, next)
    return await this.snapshot(root, next)
  }

  async snapshotCurrent(): Promise<ProjectSnapshot> {
    if (this.currentRoot === undefined) throw new Error('no project is open')
    return await this.snapshot(this.currentRoot, this.asCurrentConfig)
  }

  async recentProjects(): Promise<RecentProject[]> {
    try {
      const raw = await readFile(this.recentPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isRecentProject).slice(0, RECENT_LIMIT)
    } catch {
      return []
    }
  }

  harPath(): string {
    const root = this.requireRoot()
    const config = this.asCurrentConfig
    if (config.har_file === undefined) throw new Error('import a HAR file before running a test')
    return resolveInside(root, config.har_file)
  }

  async readHar(): Promise<ParsedHar> {
    return parseHar(await readFile(this.harPath(), 'utf8'), {
      maxBytes: DESKTOP_LIMITS.maxHarBytes,
      maxEntries: DESKTOP_LIMITS.maxRequests,
    })
  }

  async requests(): Promise<DesktopRequestView[]> {
    if (this.asCurrentConfig.har_file === undefined) return []
    const har = await this.readHar()
    return har.entries.map(entry => ({
      order: entry.order,
      method: entry.method,
      url: redactedUrl(entry),
      path: entry.path,
      headers: entry.headers,
      query: entry.query,
      body: entry.body,
    }))
  }

  async listReports(): Promise<string[]> {
    const root = this.requireRoot()
    const output = resolveInside(root, 'output')
    const entries = await readdir(output).catch(() => [])
    return entries
      .filter(name => name.endsWith('.json'))
      .map(name => resolveInside(root, join('output', name)))
      .sort()
      .reverse()
  }

  private async snapshot(root: string, config: ProjectConfig): Promise<ProjectSnapshot> {
    return {
      path: root,
      config,
      harFileName: config.har_file === undefined ? undefined : basename(config.har_file),
      requests: await this.requests(),
      recentProjects: await this.recentProjects(),
    }
  }

  private requireRoot(): string {
    if (this.currentRoot === undefined) throw new Error('no project is open')
    return this.currentRoot
  }

  private get asCurrentConfig(): ProjectConfig {
    // The config is loaded synchronously from the active project snapshot cache.
    if (this.cachedConfig === undefined) throw new Error('project configuration is not loaded')
    return this.cachedConfig
  }

  private cachedConfig: ProjectConfig | undefined

  private async readConfig(root: string): Promise<ProjectConfig> {
    const path = resolveInside(root, 'project.json')
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch (error) {
      throw new Error(`cannot read project.json: ${(error as Error).message}`)
    }
    const config = validateStoredConfig(parsed)
    this.cachedConfig = config
    return config
  }

  private async writeConfig(root: string, config: ProjectConfig): Promise<void> {
    const path = resolveInside(root, 'project.json')
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    this.cachedConfig = config
  }

  private async remember(root: string, name: string): Promise<void> {
    const existing = await this.recentProjects()
    const next: RecentProject[] = [
      { name, path: root, openedAt: new Date().toISOString() },
      ...existing.filter(item => item.path !== root),
    ].slice(0, RECENT_LIMIT)
    await mkdir(this.appDataDirectory, { recursive: true })
    await writeFile(this.recentPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  }
}

function validateConfigInput(input: SaveProjectConfigInput): SaveProjectConfigInput {
  if (input === null || typeof input !== 'object') throw new Error('project configuration must be an object')
  const target = validateTarget(input.target)
  const environment = validateEnvironment(input.environment)
  const api = validateApi(input.api)
  const performance = validatePerformance(input.performance)
  const correlations = validateCorrelations(input.correlations)
  const authorization = validateAuthorization(input.authorization)
  const credentialRef = validateCredentialRef(input.credentialRef)
  return { target, environment, api, performance, correlations, authorization, ...credentialRef === undefined ? {} : { credentialRef } }
}

function validateStoredConfig(value: unknown): ProjectConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('project.json must be an object')
  const record = value as ProjectConfig
  if (record.schema_version !== PROJECT_SCHEMA_VERSION) throw new Error(`unsupported project schema: ${String(record.schema_version)}`)
  if (!/^[0-9a-f-]{36}$/i.test(record.project_id)) throw new Error('invalid project id')
  const name = validateProjectName(record.name)
  if (typeof record.created_at !== 'string' || Number.isNaN(Date.parse(record.created_at))) throw new Error('invalid project created_at')
  if (typeof record.updated_at !== 'string' || Number.isNaN(Date.parse(record.updated_at))) throw new Error('invalid project updated_at')
  if (record.har_file !== undefined) {
    if (typeof record.har_file !== 'string' || !record.har_file.startsWith('har/') || record.har_file.includes('..')) {
      throw new Error('invalid HAR file reference')
    }
  }
  const validated = validateConfigInput(record)
  return {
    ...record,
    ...validated,
    name,
    schema_version: PROJECT_SCHEMA_VERSION,
  }
}

function validateTarget(value: SaveProjectConfigInput['target']): SaveProjectConfigInput['target'] {
  if (value === null || typeof value !== 'object') throw new Error('target configuration is required')
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  let origin = ''
  if (baseUrl.length > 0) {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error('target base URL must be a valid absolute URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('target base URL must use http or https')
    if (parsed.username !== '' || parsed.password !== '') throw new Error('target base URL must not contain credentials')
    if (parsed.search !== '') throw new Error('target base URL must not contain a query string')
    if (parsed.hash !== '') throw new Error('target base URL must not contain a fragment')
    origin = parsed.origin
  }
  const allowedOrigins = validateStringArray(value.allowedOrigins, 'allowed origins', 20)
  for (const allowed of allowedOrigins) {
    let parsed: URL
    try {
      parsed = new URL(allowed)
    } catch {
      throw new Error(`invalid allowed origin: ${allowed}`)
    }
    if (parsed.origin !== allowed) throw new Error(`allowed origin must contain only scheme, host, and port: ${allowed}`)
  }
  if (origin !== '' && !allowedOrigins.includes(origin)) {
    throw new Error('allowed origins must include the target origin')
  }
  const allowedPaths = validateStringArray(value.allowedPaths, 'allowed paths', 100)
  for (const path of allowedPaths) {
    if (!path.startsWith('/')) throw new Error(`allowed path must start with /: ${path}`)
    if (path.includes('..')) throw new Error(`allowed path must not contain '..': ${path}`)
  }
  return { baseUrl, allowedOrigins, allowedPaths }
}

function validateEnvironment(value: SaveProjectConfigInput['environment']): SaveProjectConfigInput['environment'] {
  if (value === null || typeof value !== 'object' || value.headers === null || typeof value.headers !== 'object' || Array.isArray(value.headers)) {
    throw new Error('environment.headers must be an object')
  }
  const headers: Record<string, string> = {}
  for (const [name, rawValue] of Object.entries(value.headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`invalid environment header name: ${name}`)
    if (isSensitiveHeader(name)) {
      throw new Error(`sensitive header ${name} cannot be persisted; supply credentials outside the project file`)
    }
    if (typeof rawValue !== 'string') throw new Error(`environment header ${name} must be a string`)
    if (Buffer.byteLength(rawValue, 'utf8') > DESKTOP_LIMITS.maxHeaderValueBytes) {
      throw new Error(`environment header ${name} exceeds the size limit`)
    }
    headers[name] = rawValue
  }
  return { headers }
}

function validateApi(value: SaveProjectConfigInput['api']): SaveProjectConfigInput['api'] {
  if (value === null || typeof value !== 'object') throw new Error('api configuration is required')
  const timeoutMs = validateInteger(value.timeoutMs, 'API timeout', DESKTOP_LIMITS.minTimeoutMs, DESKTOP_LIMITS.maxTimeoutMs)
  const concurrency = validateInteger(value.concurrency, 'replay concurrency', 1, DESKTOP_LIMITS.maxConcurrency)
  const assertions = validateAssertions(value.assertions)
  return { timeoutMs, concurrency, assertions }
}

function validatePerformance(value: SaveProjectConfigInput['performance']): SaveProjectConfigInput['performance'] {
  if (value === null || typeof value !== 'object') throw new Error('performance configuration is required')
  if (value.engine !== 'k6' && value.engine !== 'jmeter') throw new Error('performance engine must be k6 or jmeter')
  const vus = validateInteger(value.vus, 'virtual users', 1, DESKTOP_LIMITS.maxVus)
  const iterations = validateInteger(value.iterations, 'iterations', 1, DESKTOP_LIMITS.maxIterations)
  const timeoutMs = validateInteger(value.timeoutMs, 'engine timeout', DESKTOP_LIMITS.minTimeoutMs, DESKTOP_LIMITS.maxTimeoutMs)
  if (typeof value.duration !== 'string') throw new Error('duration must be a string')
  const duration = value.duration.trim()
  if (duration.length > 0) {
    const match = duration.match(/^(\d+)(s|m)$/)
    if (match === null) throw new Error('duration must look like 30s or 2m')
    const seconds = Number(match[1]) * (match[2] === 'm' ? 60 : 1)
    if (seconds < 1 || seconds > DESKTOP_LIMITS.maxDurationSeconds) {
      throw new Error(`duration must be between 1s and ${DESKTOP_LIMITS.maxDurationSeconds}s`)
    }
  }
  const enginePaths: Partial<Record<EngineKind, string>> = {}
  if (value.enginePaths !== null && typeof value.enginePaths === 'object') {
    for (const engine of ['k6', 'jmeter'] as const) {
      const candidate = value.enginePaths[engine]
      if (candidate !== undefined) {
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
          throw new Error(`invalid ${engine} executable path`)
        }
        enginePaths[engine] = candidate
      }
    }
  }
  return { engine: value.engine, vus, duration, iterations, timeoutMs, enginePaths }
}

function validateCorrelations(value: CorrelationConfig[]): CorrelationConfig[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('correlations must be an array of at most 100 items')
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`correlation ${index} must be an object`)
    if (!Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < 0) throw new Error(`correlation ${index} has an invalid sourceIndex`)
    if (!Array.isArray(item.targetIndexes) || !item.targetIndexes.every(target => Number.isSafeInteger(target) && target >= 0)) {
      throw new Error(`correlation ${index} targetIndexes must contain non-negative integers`)
    }
    if (typeof item.jsonPath !== 'string' || !item.jsonPath.startsWith('$')) throw new Error(`correlation ${index} jsonPath must start with $`)
    if (typeof item.variableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(item.variableName)) {
      throw new Error(`correlation ${index} has an invalid variableName`)
    }
    const targetHeaders = item.targetHeaders?.map(header => {
      if (header === null || typeof header !== 'object') throw new Error(`correlation ${index} targetHeaders must contain objects`)
      if (!Number.isSafeInteger(header.index) || header.index <= item.sourceIndex) {
        throw new Error(`correlation ${index} target header index must be after sourceIndex`)
      }
      if (typeof header.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name)) {
        throw new Error(`correlation ${index} target header name is invalid`)
      }
      if (header.value !== undefined && (typeof header.value !== 'string' || header.value.length > 2000 || !header.value.includes(`\${${item.variableName}}`))) {
        throw new Error(`correlation ${index} target header value must reference its variable`)
      }
      return { index: header.index, name: header.name, ...header.value === undefined ? {} : { value: header.value } }
    })
    return {
      sourceIndex: item.sourceIndex,
      jsonPath: item.jsonPath,
      variableName: item.variableName,
      targetIndexes: [...item.targetIndexes],
      ...targetHeaders === undefined || targetHeaders.length === 0 ? {} : { targetHeaders },
    }
  })
}

function validateAssertions(value: AssertionConfig[]): AssertionConfig[] {
  if (!Array.isArray(value) || value.length > DESKTOP_LIMITS.maxRequests) throw new Error('assertions must be an array')
  return value.map((item, position) => {
    if (item === null || typeof item !== 'object') throw new Error(`assertion ${position} must be an object`)
    const assertion = { ...item }
    if (assertion.index !== undefined && (!Number.isSafeInteger(assertion.index) || assertion.index < 0)) {
      throw new Error(`assertion ${position} index must be a non-negative integer`)
    }
    if (assertion.path !== undefined && (typeof assertion.path !== 'string' || !assertion.path.startsWith('/'))) {
      throw new Error(`assertion ${position} path must start with /`)
    }
    if (assertion.status !== undefined && (!Number.isSafeInteger(assertion.status) || assertion.status < 100 || assertion.status > 599)) {
      throw new Error(`assertion ${position} status must be between 100 and 599`)
    }
    if (assertion.jsonPath !== undefined && (typeof assertion.jsonPath !== 'string' || !assertion.jsonPath.startsWith('$'))) {
      throw new Error(`assertion ${position} jsonPath must start with $`)
    }
    if (assertion.contains !== undefined && typeof assertion.contains !== 'string') {
      throw new Error(`assertion ${position} contains must be a string`)
    }
    if (assertion.maxDurationMs !== undefined && (!Number.isSafeInteger(assertion.maxDurationMs) || assertion.maxDurationMs <= 0)) {
      throw new Error(`assertion ${position} maxDurationMs must be a positive integer`)
    }
    if (!['status', 'jsonPath', 'contains', 'maxDurationMs'].some(key => assertion[key as keyof AssertionConfig] !== undefined)) {
      throw new Error(`assertion ${position} must declare at least one condition`)
    }
    return assertion
  })
}

function validateAuthorization(value: SaveProjectConfigInput['authorization']): SaveProjectConfigInput['authorization'] {
  if (value === null || typeof value !== 'object' || typeof value.confirmed !== 'boolean') {
    throw new Error('authorization.confirmed must be a boolean')
  }
  if (typeof value.scope !== 'string' || value.scope.length > 2000) throw new Error('authorization.scope must be a string')
  if (value.confirmed && value.scope.trim().length === 0) throw new Error('authorization scope is required when authorization is confirmed')
  return { confirmed: value.confirmed, scope: value.scope.trim() }
}

function validateCredentialRef(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  if (!/^safe:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/.test(value.trim())) {
    throw new Error('credential reference must use safe://<id>')
  }
  return value.trim()
}

function validateProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('project name is required')
  const name = value.trim()
  if (name.length < 1 || name.length > 80) throw new Error('project name must be between 1 and 80 characters')
  if (/[\u0000-\u001f/\\]/.test(name)) throw new Error('project name contains invalid characters')
  return name
}

function validateStringArray(value: unknown, name: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error(`${name} must be an array of at most ${maxItems} non-empty strings`)
  }
  return [...new Set(value)]
}

function validateInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}

function isRecentProject(value: unknown): value is RecentProject {
  if (value === null || typeof value !== 'object') return false
  const record = value as RecentProject
  return typeof record.name === 'string'
    && typeof record.path === 'string'
    && record.path.startsWith('/')
    && typeof record.openedAt === 'string'
}

async function uniqueDirectory(parent: string, slug: string): Promise<string> {
  const base = join(parent, slug)
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`
    try {
      await stat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('could not allocate a project directory')
}

function toSanitizedHar(parsed: ParsedHar): { log: { version: string; creator: { name: string; version: string }; entries: unknown[] } } {
  return {
    log: {
      version: '1.2',
      creator: { name: 'test-agent', version: '0.1.0' },
      entries: parsed.entries.map(entry => ({
        request: {
          method: entry.method,
          url: redactedUrl(entry),
          headers: entry.headers.map(header => ({ name: header.name, value: header.value })),
          queryString: entry.query.map(query => ({ name: query.name, value: query.value })),
          ...entry.body === undefined ? {} : {
            postData: {
              mimeType: looksLikeJson(entry.body) ? 'application/json' : 'text/plain',
              text: entry.body,
            },
          },
        },
      })),
    },
  }
}

function looksLikeJson(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function redactedUrl(entry: { url: string; query: Array<{ name: string; value: string }> }): string {
  const url = new URL(entry.url)
  url.search = ''
  for (const query of entry.query) url.searchParams.append(query.name, query.value)
  return url.toString()
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}
