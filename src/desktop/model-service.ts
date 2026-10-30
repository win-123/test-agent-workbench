import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactSensitiveText } from './security.ts'

export const MODEL_CONFIG_SCHEMA_VERSION = 'test-agent.model-config/v1' as const

export type ModelProviderKind = 'openai-compatible' | 'deepseek' | 'custom-openai-compatible'

export interface StoredModelConfig {
  schema_version: typeof MODEL_CONFIG_SCHEMA_VERSION
  provider: ModelProviderKind
  base_url: string
  model: string
  chat_path: string
  timeout_ms: number
  max_tokens: number
  api_key_encrypted?: string
  updated_at: string
  last_connection?: {
    status: 'available' | 'unavailable'
    checked_at: string
    error?: string
  }
}

export interface PublicModelConfig {
  provider: ModelProviderKind
  baseUrl: string
  model: string
  chatPath: string
  timeoutMs: number
  maxTokens: number
  hasApiKey: boolean
  encryptionAvailable: boolean
  lastConnection?: StoredModelConfig['last_connection']
}

export interface SaveModelConfigInput {
  provider: ModelProviderKind
  baseUrl: string
  model: string
  chatPath?: string
  timeoutMs?: number
  maxTokens?: number
  /** undefined keeps the current key, null removes it, a string replaces it. */
  apiKey?: string | null
}

export interface ModelConnectionResult {
  status: 'available' | 'unavailable'
  checkedAt: string
  error?: string
}

export interface SecretCodec {
  isEncryptionAvailable(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface ModelServiceOptions {
  appDataDirectory: string
  codec: SecretCodec
  fetch?: typeof fetch
  now?: () => Date
}

export class ModelConfigService {
  private readonly configPath: string
  private readonly codec: SecretCodec
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private cache?: StoredModelConfig

  constructor(options: ModelServiceOptions) {
    this.configPath = join(options.appDataDirectory, 'model-config.json')
    this.codec = options.codec
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? ((): Date => new Date())
  }

  async load(): Promise<StoredModelConfig | undefined> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.configPath, 'utf8')) as unknown
      if (!isRecord(parsed) || parsed['schema_version'] !== MODEL_CONFIG_SCHEMA_VERSION) throw new Error('unsupported model config schema')
      this.cache = validateStoredConfig(parsed)
      return this.cache
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(`cannot read model configuration: ${redactSensitiveText((error as Error).message)}`)
    }
  }

  async publicConfig(): Promise<PublicModelConfig> {
    const stored = await this.load()
    return {
      encryptionAvailable: this.codec.isEncryptionAvailable(),
      ...(stored === undefined
        ? {
            provider: 'openai-compatible',
            baseUrl: '',
            model: '',
            chatPath: '/chat/completions',
            timeoutMs: 30_000,
            maxTokens: 4096,
            hasApiKey: false,
          }
        : {
            provider: stored.provider,
            baseUrl: stored.base_url,
            model: stored.model,
            chatPath: stored.chat_path,
            timeoutMs: stored.timeout_ms,
            maxTokens: stored.max_tokens,
            hasApiKey: stored.api_key_encrypted !== undefined,
            ...stored.last_connection === undefined ? {} : { lastConnection: stored.last_connection },
          }),
    }
  }

  async save(input: SaveModelConfigInput): Promise<PublicModelConfig> {
    const previous = await this.load()
    const provider = validateProvider(input.provider)
    const baseUrl = validateBaseUrl(input.baseUrl)
    const model = validateModel(input.model)
    const chatPath = validatePath(input.chatPath ?? '/chat/completions', 'chat path')
    const timeoutMs = boundedInteger(input.timeoutMs ?? 30_000, 1_000, 120_000, 'timeout')
    const maxTokens = boundedInteger(input.maxTokens ?? 4096, 256, 32_768, 'max tokens')
    const next: StoredModelConfig = {
      schema_version: MODEL_CONFIG_SCHEMA_VERSION,
      provider,
      base_url: baseUrl,
      model,
      chat_path: chatPath,
      timeout_ms: timeoutMs,
      max_tokens: maxTokens,
      updated_at: this.now().toISOString(),
      ...previous?.last_connection === undefined ? {} : { last_connection: previous.last_connection },
    }
    if (input.apiKey === null) {
      // Key intentionally removed.
    } else if (input.apiKey === undefined) {
      if (previous?.api_key_encrypted !== undefined) next.api_key_encrypted = previous.api_key_encrypted
    } else {
      const key = input.apiKey.trim()
      if (key.length > 0) {
        if (key.length > 4096) throw new Error('API key exceeds the 4096 character limit')
        if (!this.codec.isEncryptionAvailable()) throw new Error('secure secret storage is unavailable; refusing to persist an API key')
        next.api_key_encrypted = this.codec.encrypt(key)
      }
    }
    await mkdir(join(this.configPath, '..'), { recursive: true })
    const temporary = `${this.configPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.configPath)
    this.cache = next
    return await this.publicConfig()
  }

  async testConnection(): Promise<ModelConnectionResult> {
    const config = await this.requireConfig()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('model connection timeout')), config.timeout_ms)
    try {
      const response = await this.fetchImpl(endpointUrl(config.base_url, '/models'), {
        method: 'GET',
        headers: this.headers(config),
        signal: controller.signal,
      })
      const body = await boundedText(response, 64 * 1024)
      if (!response.ok) throw new Error(httpError(response.status, body))
      const checkedAt = this.now().toISOString()
      this.cache = {
        ...config,
        last_connection: { status: 'available', checked_at: checkedAt },
      }
      await this.writeCache()
      return { status: 'available', checkedAt }
    } catch (error) {
      const checkedAt = this.now().toISOString()
      const errorMessage = safeModelError(error)
      this.cache = {
        ...config,
        last_connection: { status: 'unavailable', checked_at: checkedAt, error: errorMessage },
      }
      await this.writeCache()
      return { status: 'unavailable', checkedAt, error: errorMessage }
    } finally {
      clearTimeout(timer)
    }
  }

  async complete(input: { system: string; prompt: string; signal?: AbortSignal }): Promise<string> {
    const config = await this.requireConfig()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('model request timeout')), config.timeout_ms)
    const forward = (): void => controller.abort(input.signal?.reason ?? new Error('model request cancelled'))
    input.signal?.addEventListener('abort', forward, { once: true })
    try {
      const response = await this.fetchImpl(endpointUrl(config.base_url, config.chat_path), {
        method: 'POST',
        headers: this.headers(config),
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.max_tokens,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.prompt },
          ],
        }),
        signal: controller.signal,
      })
      const body = await boundedText(response, 512 * 1024)
      if (!response.ok) throw new Error(httpError(response.status, body))
      let parsed: unknown
      try {
        parsed = JSON.parse(body) as unknown
      } catch {
        throw new Error('model gateway returned invalid JSON')
      }
      const choice = asChoice(parsed)
      const content = choice?.message?.content
      const text = typeof content === 'string' ? content : content?.map(item => item.text ?? '').join('')
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('model gateway returned no text content')
      if (choice?.finish_reason === 'length') throw new Error('model output was truncated by the token limit')
      return text
    } catch (error) {
      throw new Error(safeModelError(error))
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', forward)
    }
  }

  private headers(config: StoredModelConfig): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.api_key_encrypted !== undefined) {
      try {
        headers.authorization = `Bearer ${this.codec.decrypt(config.api_key_encrypted)}`
      } catch {
        throw new Error('stored API key cannot be decrypted on this machine')
      }
    }
    return headers
  }

  private async requireConfig(): Promise<StoredModelConfig> {
    const config = await this.load()
    if (config === undefined) throw new Error('model gateway is not configured')
    return config
  }

  private async writeCache(): Promise<void> {
    if (this.cache === undefined) return
    const temporary = `${this.configPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.cache, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.configPath)
  }
}

function validateStoredConfig(value: Record<string, unknown>): StoredModelConfig {
  const result = validateFields(value)
  if (typeof result.api_key_encrypted === 'string' && result.api_key_encrypted.length > 0) {
    return { ...result, api_key_encrypted: result.api_key_encrypted }
  }
  if (result.api_key_encrypted !== undefined) throw new Error('invalid stored API key')
  return result
}

function validateFields(value: Record<string, unknown>): StoredModelConfig {
  return {
    schema_version: MODEL_CONFIG_SCHEMA_VERSION,
    provider: validateProvider(value['provider']),
    base_url: validateBaseUrl(String(value['base_url'] ?? '')),
    model: validateModel(String(value['model'] ?? '')),
    chat_path: validatePath(String(value['chat_path'] ?? '/chat/completions'), 'chat path'),
    timeout_ms: boundedInteger(value['timeout_ms'], 1_000, 120_000, 'timeout'),
    max_tokens: boundedInteger(value['max_tokens'], 256, 32_768, 'max tokens'),
    api_key_encrypted: typeof value['api_key_encrypted'] === 'string' && value['api_key_encrypted'].length > 0 ? value['api_key_encrypted'] : undefined,
    updated_at: String(value['updated_at'] ?? ''),
    ...value['last_connection'] === undefined ? {} : { last_connection: validateLastConnection(value['last_connection']) },
  }
}

function validateProvider(value: unknown): ModelProviderKind {
  if (value === 'openai-compatible' || value === 'deepseek' || value === 'custom-openai-compatible') return value
  throw new Error('provider must be openai-compatible, deepseek, or custom-openai-compatible')
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('model base URL is required')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('model base URL must be absolute')
  }
  if (url.username !== '' || url.password !== '') throw new Error('model base URL must not contain credentials')
  if (url.search !== '' || url.hash !== '') throw new Error('model base URL must not contain a query string or fragment')
  if (url.protocol === 'https:') return url.toString()
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.toString()
  throw new Error('non-local model gateway must use HTTPS')
}

function validateModel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.length > 200) throw new Error('model name must contain 1-200 characters')
  return value.trim()
}

function validatePath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('..') || value.length > 200) throw new Error(`${name} must be a bounded absolute path`)
  return value
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return Number(value)
}

function validateLastConnection(value: unknown): StoredModelConfig['last_connection'] {
  if (!isRecord(value) || (value['status'] !== 'available' && value['status'] !== 'unavailable')) throw new Error('invalid last model connection')
  return {
    status: value['status'],
    checked_at: String(value['checked_at'] ?? ''),
    ...typeof value['error'] === 'string' ? { error: value['error'] } : {},
  }
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const raw = await response.arrayBuffer()
  if (raw.byteLength > maxBytes) throw new Error(`model response exceeds ${maxBytes} bytes`)
  return new TextDecoder().decode(raw)
}

function httpError(status: number, body: string): string {
  if (status === 401 || status === 403) return 'model gateway rejected credentials'
  if (status === 404) return 'model gateway route was not found'
  if (status === 429) return 'model gateway rate limit reached'
  if (status >= 500) return `model gateway server error (${status})`
  return `model gateway HTTP ${status}: ${redactSensitiveText(body.slice(0, 300))}`
}

function safeModelError(error: unknown): string {
  const message = (error as Error).message
  if (message === 'model request timeout' || message === 'model connection timeout') return message
  return redactSensitiveText(message)
}

function asChoice(value: unknown): { message?: { content?: string | Array<{ text?: string }> }, finish_reason?: string } | undefined {
  if (!isRecord(value) || !Array.isArray(value['choices'])) return undefined
  const choice = value['choices'][0]
  if (!isRecord(choice) || !isRecord(choice['message'])) return undefined
  const message = choice['message']
  const content = message['content']
  return {
    message: { content: typeof content === 'string' ? content : Array.isArray(content) ? content : undefined },
    finish_reason: typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function endpointUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ''), baseUrl)
}
