import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertTargetNetworkAllowed, createTargetPolicy } from '../api/policy.ts'
import { redactSensitiveText } from './security.ts'
import type { SecretCodec } from './model-service.ts'

export const CREDENTIAL_STORE_SCHEMA_VERSION = 'test-agent.credentials/v1' as const

export type CredentialKind = 'bearer' | 'header' | 'cookie' | 'basic'

export interface StoredCredential {
  id: string
  label: string
  kind: CredentialKind
  header_name?: string
  username?: string
  secret_encrypted: string
  created_at: string
  updated_at: string
}

export interface PublicCredential {
  id: string
  reference: string
  label: string
  kind: CredentialKind
  headerName?: string
  username?: string
  updatedAt: string
}

export interface SaveCredentialInput {
  id?: string
  label: string
  kind: CredentialKind
  headerName?: string
  username?: string
  /** undefined preserves an existing secret; a string replaces it. */
  secret?: string
}

export interface CredentialTestResult {
  status: 'available' | 'unauthorized' | 'unavailable'
  httpStatus?: number
  checkedAt: string
  error?: string
}

interface CredentialStore {
  schema_version: typeof CREDENTIAL_STORE_SCHEMA_VERSION
  credentials: StoredCredential[]
}

export interface CredentialServiceOptions {
  appDataDirectory: string
  codec: SecretCodec
  fetch?: typeof fetch
  now?: () => Date
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/
const REFERENCE_PATTERN = /^safe:\/\/[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function credentialReference(id: string): string {
  return `safe://${id}`
}

export function isCredentialReference(value: string): boolean {
  return REFERENCE_PATTERN.test(value)
}

export class CredentialService {
  private readonly path: string
  private readonly codec: SecretCodec
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private cache?: CredentialStore

  constructor(options: CredentialServiceOptions) {
    this.path = join(options.appDataDirectory, 'credentials.json')
    this.codec = options.codec
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? ((): Date => new Date())
  }

  async list(): Promise<PublicCredential[]> {
    return (await this.load()).credentials
      .map(credential => this.publicCredential(credential))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async save(input: SaveCredentialInput): Promise<PublicCredential> {
    const store = await this.load()
    const id = input.id === undefined ? `credential_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` : input.id
    if (!ID_PATTERN.test(id)) throw new Error('credential id is invalid')
    const label = requiredText(input.label, 'credential label', 160)
    const kind = validateKind(input.kind)
    const headerName = kind === 'header' ? requiredHeader(input.headerName) : undefined
    const username = kind === 'basic' ? requiredText(input.username, 'basic username', 320) : undefined
    const existingIndex = store.credentials.findIndex(item => item.id === id)
    const existing = existingIndex >= 0 ? store.credentials[existingIndex] : undefined
    if (input.secret !== undefined && input.secret.length > 4096) throw new Error('credential secret exceeds the size limit')
    if (input.secret !== undefined && input.secret.length > 0 && !this.codec.isEncryptionAvailable()) {
      throw new Error('secure credential storage is unavailable')
    }
    let secretEncrypted = existing?.secret_encrypted
    if (input.secret !== undefined) {
      if (input.secret.length === 0) throw new Error('credential secret cannot be empty; delete the credential instead')
      secretEncrypted = this.codec.encrypt(input.secret)
    }
    if (secretEncrypted === undefined) throw new Error('credential secret is required')

    const timestamp = this.now().toISOString()
    const record: StoredCredential = {
      id,
      label,
      kind,
      ...headerName === undefined ? {} : { header_name: headerName },
      ...username === undefined ? {} : { username },
      secret_encrypted: secretEncrypted,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    }
    if (existingIndex >= 0) store.credentials[existingIndex] = record
    else store.credentials.push(record)
    await this.persist(store)
    return this.publicCredential(record)
  }

  async delete(id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) throw new Error('credential id is invalid')
    const store = await this.load()
    const next = store.credentials.filter(credential => credential.id !== id)
    if (next.length === store.credentials.length) throw new Error(`credential not found: ${id}`)
    await this.persist({ ...store, credentials: next })
  }

  async resolveHeaders(reference: string | undefined): Promise<Record<string, string>> {
    if (reference === undefined || reference.trim().length === 0) return {}
    if (!REFERENCE_PATTERN.test(reference)) throw new Error('credential reference must use safe://<id>')
    const id = reference.slice('safe://'.length)
    const credential = (await this.load()).credentials.find(item => item.id === id)
    if (credential === undefined) throw new Error(`credential not found: ${id}`)
    let secret: string
    try {
      secret = this.codec.decrypt(credential.secret_encrypted)
    } catch {
      throw new Error(`credential cannot be decrypted on this machine: ${id}`)
    }
    if (credential.kind === 'bearer') return { authorization: `Bearer ${secret}` }
    if (credential.kind === 'cookie') return { cookie: secret }
    if (credential.kind === 'header') return { [credential.header_name!]: secret }
    return { authorization: `Basic ${Buffer.from(`${credential.username}:${secret}`).toString('base64')}` }
  }

  async testConnection(reference: string, baseUrl: string): Promise<CredentialTestResult> {
    const headers = await this.resolveHeaders(reference)
    let origin = ''
    try {
      const policy = createTargetPolicy(baseUrl, [new URL(baseUrl).origin])
      origin = policy.baseUrl
    } catch {
      return { status: 'unavailable', checkedAt: this.now().toISOString(), error: 'target URL is invalid' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('credential test timeout')), 10_000)
    try {
      await assertTargetNetworkAllowed(origin)
      const response = await this.fetchImpl(origin, { method: 'GET', headers, signal: controller.signal })
      if (response.status === 401 || response.status === 403) {
        return { status: 'unauthorized', httpStatus: response.status, checkedAt: this.now().toISOString() }
      }
      if (response.status >= 200 && response.status < 500) {
        return { status: 'available', httpStatus: response.status, checkedAt: this.now().toISOString() }
      }
      return { status: 'unavailable', httpStatus: response.status, checkedAt: this.now().toISOString(), error: `target returned HTTP ${response.status}` }
    } catch (error) {
      return { status: 'unavailable', checkedAt: this.now().toISOString(), error: redactSensitiveText((error as Error).message) }
    } finally {
      clearTimeout(timer)
    }
  }

  private async load(): Promise<CredentialStore> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as CredentialStore
      if (parsed.schema_version !== CREDENTIAL_STORE_SCHEMA_VERSION || !Array.isArray(parsed.credentials)) {
        throw new Error('unsupported credential store schema')
      }
      this.cache = { schema_version: CREDENTIAL_STORE_SCHEMA_VERSION, credentials: parsed.credentials.map(validateStored) }
      return this.cache
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = { schema_version: CREDENTIAL_STORE_SCHEMA_VERSION, credentials: [] }
        return this.cache
      }
      throw new Error(`cannot read credential store: ${(error as Error).message}`)
    }
  }

  private async persist(store: CredentialStore): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await mkdir(join(this.path, '..'), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
    this.cache = store
  }

  private publicCredential(credential: StoredCredential): PublicCredential {
    return {
      id: credential.id,
      reference: credentialReference(credential.id),
      label: credential.label,
      kind: credential.kind,
      ...credential.header_name === undefined ? {} : { headerName: credential.header_name },
      ...credential.username === undefined ? {} : { username: credential.username },
      updatedAt: credential.updated_at,
    }
  }
}

function validateStored(value: StoredCredential): StoredCredential {
  if (!ID_PATTERN.test(value.id)) throw new Error('invalid stored credential id')
  if (!['bearer', 'header', 'cookie', 'basic'].includes(value.kind)) throw new Error('invalid stored credential kind')
  if (typeof value.secret_encrypted !== 'string' || value.secret_encrypted.length === 0) throw new Error('invalid stored credential secret')
  return value
}

function validateKind(value: CredentialKind): CredentialKind {
  if (!['bearer', 'header', 'cookie', 'basic'].includes(value)) throw new Error('credential kind must be bearer, header, cookie, or basic')
  return value
}

function requiredText(value: string | undefined, name: string, max: number): string {
  if (value === undefined || value.trim().length === 0 || value.length > max) throw new Error(`${name} must contain 1-${max} characters`)
  return value.trim()
}

function requiredHeader(value: string | undefined): string {
  if (value === undefined || !HEADER_NAME_PATTERN.test(value)) throw new Error('credential header name is invalid')
  if (/^(authorization|cookie|proxy-authorization)$/i.test(value)) throw new Error('use bearer, cookie, or basic credential kind for sensitive headers')
  return value
}
