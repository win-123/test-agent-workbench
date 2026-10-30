import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentService } from '../../src/desktop/agent-service.ts'
import { draftStructuredPlan } from '../../src/agent/planner.ts'
import { ModelConfigService, type SecretCodec } from '../../src/desktop/model-service.ts'
import { ProjectService } from '../../src/desktop/project-service.ts'
import { ProjectRunGate } from '../../src/desktop/task-service.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const available = await canBindLocalFixture()
let server: Server | undefined
let origin = ''

beforeAll(async () => {
  if (!available) return
  server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      if (request.url === '/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'phase7-model' }] }))
        return
      }
      if (request.url !== '/chat/completions') {
        response.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as { messages?: Array<{ content?: string }> }
      const prompt = body.messages?.at(-1)?.content ?? ''
      const output = prompt.includes('INVALID_MODEL_OUTPUT')
        ? '{invalid model json'
        : JSON.stringify({ ...basePlan(), goal: 'Local gateway model plan' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        choices: [{ message: { content: output }, finish_reason: 'stop' }],
      }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describe.skipIf(!available)('phase 7 model gateway integration', () => {
  it('uses a real OpenAI-compatible HTTP gateway and falls back safely on invalid output', async () => {
    const evidenceDirectory = process.env.PHASE7_MODEL_EVIDENCE_DIR
    const directory = evidenceDirectory === undefined
      ? await mkdtemp(join(tmpdir(), 'test-agent-model-gateway-'))
      : (await mkdir(evidenceDirectory, { recursive: true }), evidenceDirectory)
    const projects = new ProjectService({ appDataDirectory: join(directory, 'app-data') })
    await projects.initialize()
    await projects.create('Model gateway', directory)
    await projects.importHar('samples/demo.har')
    await projects.saveConfig({
      target: { baseUrl: 'http://127.0.0.1:1', allowedOrigins: ['http://127.0.0.1:1'], allowedPaths: [] },
      environment: { headers: {} },
      api: { timeoutMs: 1000, concurrency: 1, assertions: [] },
      performance: { engine: 'k6', vus: 1, duration: '', iterations: 1, timeoutMs: 5000, enginePaths: {} },
      correlations: [],
      authorization: { confirmed: true, scope: 'local model fixture only' },
    })
    const codec: SecretCodec = {
      isEncryptionAvailable: () => true,
      encrypt: value => Buffer.from(value).toString('base64'),
      decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
    }
    const modelDataDirectory = evidenceDirectory === undefined
      ? join(directory, 'model-data')
      : await mkdtemp(join(tmpdir(), 'test-agent-model-gateway-data-'))
    const gateway = new ModelConfigService({ appDataDirectory: modelDataDirectory, codec })
    await gateway.save({
      provider: 'openai-compatible',
      baseUrl: `${origin}/`,
      model: 'phase7-model',
      apiKey: 'phase7-local-key',
      timeoutMs: 5000,
      maxTokens: 1024,
    })
    const stored = await readFile(join(modelDataDirectory, 'model-config.json'), 'utf8')
    expect(stored).not.toContain('phase7-local-key')
    await expect(gateway.testConnection()).resolves.toMatchObject({ status: 'available' })

    const gate = new ProjectRunGate()
    const agents = new AgentService({ projects, gate, model: gateway })
    const preview = await agents.previewPlan('Generate a plan', 'none')
    expect(preview.modelStatus).toBe('available')
    expect(preview.planSource).toBe('model')
    expect(preview.plan.goal).toBe('Local gateway model plan')
    expect(preview.validation.valid).toBe(true)
    await expect(agents.start({ plan: preview.plan, planHash: preview.planHash, confirmed: false }))
      .rejects.toThrow('explicit confirmation')

    const invalid = await agents.previewPlan('INVALID_MODEL_OUTPUT', 'none')
    expect(invalid.modelStatus).toBe('unavailable')
    expect(invalid.planSource).toBe('deterministic')
    expect(invalid.modelError).toContain('model did not return valid JSON')

    const deterministic = await new AgentService({ projects, gate }).previewPlan('No model', 'none')
    expect(deterministic.modelStatus).toBe('unavailable')
    expect(deterministic.planSource).toBe('deterministic')

    if (evidenceDirectory !== undefined) {
      await writeFile(join(evidenceDirectory, 'model-gateway-summary.json'), `${JSON.stringify({
        schema_version: 'test-agent.phase7-model-gateway/v1',
        generated_at: new Date().toISOString(),
        gateway_kind: 'local OpenAI-compatible HTTP fixture',
        model_config: await gateway.publicConfig(),
        connection: await gateway.testConnection(),
        model_plan: {
          status: preview.modelStatus,
          source: preview.planSource,
          goal: preview.plan.goal,
          plan_hash: preview.planHash,
          validation: preview.validation,
          unconfirmed_execution_rejected: true,
        },
        invalid_output_fallback: {
          status: invalid.modelStatus,
          source: invalid.planSource,
          error: invalid.modelError,
        },
        deterministic_fallback: {
          status: deterministic.modelStatus,
          source: deterministic.planSource,
        },
        security: {
          plaintext_api_key_in_config_file: false,
          plaintext_api_key_in_summary: false,
          model_output_schema_validated: true,
          execution_requires_confirmation: true,
        },
      }, null, 2)}\n`, { mode: 0o600 })
    }
  })
})

function basePlan() {
  return draftStructuredPlan({
    goal: 'deterministic goal',
    taskId: 'agent_phase7_model_gateway',
    harPath: 'samples/demo.har',
    baseUrl: 'http://127.0.0.1:1',
    authorizationScope: 'local model fixture only',
    engine: 'none',
    allowedOrigins: ['http://127.0.0.1:1'],
  })
}
