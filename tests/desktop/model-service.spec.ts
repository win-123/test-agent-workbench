import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelConfigService, type SecretCodec } from '../../src/desktop/model-service.ts'

const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: value => Buffer.from(value, 'utf8').toString('base64'),
  decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
}

describe('desktop model gateway configuration', () => {
  it('persists only an encrypted API key and reports a masked public config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-model-'))
    const service = new ModelConfigService({ appDataDirectory: directory, codec })
    const saved = await service.save({
      provider: 'deepseek',
      baseUrl: 'https://model.example.test/v1',
      model: 'test-model',
      apiKey: 'secret-key-value',
    })
    expect(saved.hasApiKey).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('secret-key-value')
    const raw = await readFile(join(directory, 'model-config.json'), 'utf8')
    expect(raw).not.toContain('secret-key-value')
    expect(raw).toContain('api_key_encrypted')
  })

  it('uses a real OpenAI-compatible HTTP response and never leaks credentials in errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-model-http-'))
    let authorization = ''
    const service = new ModelConfigService({
      appDataDirectory: directory,
      codec,
      fetch: (async (input, init) => {
        authorization = new Headers(init?.headers).get('authorization') ?? ''
        expect(String(input)).toBe('https://model.example.test/v1/chat/completions')
        return new Response(JSON.stringify({
          choices: [{ message: { content: 'model text' }, finish_reason: 'stop' }],
        }), { status: 200 })
      }) as typeof fetch,
    })
    await service.save({
      provider: 'openai-compatible',
      baseUrl: 'https://model.example.test/v1/',
      model: 'test-model',
      apiKey: 'secret-key-value',
    })
    await expect(service.complete({ system: 'system', prompt: 'prompt' })).resolves.toBe('model text')
    expect(authorization).toBe('Bearer secret-key-value')
  })

  it('rejects insecure external URLs and plaintext persistence without secure storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-model-insecure-'))
    const service = new ModelConfigService({ appDataDirectory: directory, codec })
    await expect(service.save({
      provider: 'openai-compatible',
      baseUrl: 'http://model.example.test',
      model: 'model',
    })).rejects.toThrow('HTTPS')
    const insecure = new ModelConfigService({
      appDataDirectory: directory,
      codec: { isEncryptionAvailable: () => false, encrypt: () => '', decrypt: () => '' },
    })
    await expect(insecure.save({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'model',
      apiKey: 'secret',
    })).rejects.toThrow('secure secret storage')
  })
})
