import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CredentialService } from '../../src/desktop/credential-service.ts'
import type { SecretCodec } from '../../src/desktop/model-service.ts'

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: value => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
}

describe('credential service', () => {
  it('stores only an encrypted secret and exposes references without values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-credentials-'))
    const service = new CredentialService({ appDataDirectory: directory, codec })
    const saved = await service.save({
      id: 'orders_api',
      label: 'Orders API token',
      kind: 'bearer',
      secret: 'super-secret-token',
    })
    expect(saved.reference).toBe('safe://orders_api')
    const publicJson = JSON.stringify(await service.list())
    expect(publicJson).not.toContain('super-secret-token')
    const raw = await readFile(join(directory, 'credentials.json'), 'utf8')
    expect(raw).not.toContain('super-secret-token')
    expect(raw).toContain('secret_encrypted')
  })

  it('resolves bearer, cookie, custom header, and basic credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-credential-kinds-'))
    const service = new CredentialService({ appDataDirectory: directory, codec })
    await service.save({ id: 'bearer', label: 'bearer', kind: 'bearer', secret: 'token-value' })
    await service.save({ id: 'cookie', label: 'cookie', kind: 'cookie', secret: 'session-value' })
    await service.save({ id: 'header', label: 'header', kind: 'header', headerName: 'X-Api-Token', secret: 'header-value' })
    await service.save({ id: 'basic', label: 'basic', kind: 'basic', username: 'demo-user', secret: 'demo-password' })
    await expect(service.resolveHeaders('safe://bearer')).resolves.toEqual({ authorization: 'Bearer token-value' })
    await expect(service.resolveHeaders('safe://cookie')).resolves.toEqual({ cookie: 'session-value' })
    await expect(service.resolveHeaders('safe://header')).resolves.toEqual({ 'X-Api-Token': 'header-value' })
    const basic = await service.resolveHeaders('safe://basic')
    expect(basic.authorization).toBe(`Basic ${Buffer.from('demo-user:demo-password').toString('base64')}`)
  })

  it('reports authorization failure without leaking the secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-credential-test-'))
    let authorization = ''
    const service = new CredentialService({
      appDataDirectory: directory,
      codec,
      fetch: (async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        return new Response('', { status: 401 })
      }) as typeof fetch,
    })
    await service.save({ id: 'test', label: 'test', kind: 'bearer', secret: 'secret-in-transit' })
    const result = await service.testConnection('safe://test', 'https://api.example.test')
    expect(result).toMatchObject({ status: 'unauthorized', httpStatus: 401 })
    expect(authorization).toBe('Bearer secret-in-transit')
    expect(JSON.stringify(result)).not.toContain('secret-in-transit')
    await expect(service.resolveHeaders('safe://missing')).rejects.toThrow('credential not found: missing')
  })

  it('rejects insecure storage and invalid references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-credential-invalid-'))
    const insecure = new CredentialService({
      appDataDirectory: directory,
      codec: { isEncryptionAvailable: () => false, encrypt: () => '', decrypt: () => '' },
    })
    await expect(insecure.save({ id: 'bad', label: 'bad', kind: 'bearer', secret: 'secret' }))
      .rejects.toThrow('secure credential storage is unavailable')
    const service = new CredentialService({ appDataDirectory: directory, codec })
    await expect(service.resolveHeaders('env://not-supported')).rejects.toThrow('safe://<id>')
  })
})
