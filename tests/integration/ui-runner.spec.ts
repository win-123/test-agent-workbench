import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runUiTestCase } from '../../src/ui/runner.ts'
import { validCase } from '../helpers/ui-case.ts'
import { canBindLocalFixture } from './fixture-support.ts'

const localFixtureAvailable = await canBindLocalFixture()
let server: Server | undefined
let origin = ''

beforeAll(async () => {
  if (!localFixtureAvailable) return
  const fixtureRoot = join(process.cwd(), 'fixtures', 'ui-site')
  server = createServer(async (request, response) => {
    const path = request.url === '/' ? '/index.html' : (request.url ?? '/index.html').split('?')[0]
    try {
      const body = await readFile(join(fixtureRoot, path))
      response.writeHead(200, { 'content-type': mime(path) })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('not found')
    }
  })
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()))
})

describe.skipIf(!localFixtureAvailable)('real Playwright UI execution', () => {
  it('logs in, searches and submits a form', async () => {
    const testCase = validCase({
      case_id: 'ui-login-search-submit',
      name: 'Login, search and submit',
      target_url: `${origin}/`,
      allowed_origins: [origin],
      steps: [
        { id: 'open', action: 'navigate', url: `${origin}/` },
        { id: 'username', action: 'fill', locator: { kind: 'label', value: 'Username' }, value: 'demo' },
        { id: 'password', action: 'fill', locator: { kind: 'label', value: 'Password' }, value: 'demo123' },
        { id: 'login', action: 'click', locator: { kind: 'role', role: 'button', name: 'Open workspace', value: 'Open workspace' } },
        { id: 'workspace', action: 'assert', assertion: 'visible', locator: { kind: 'text', value: 'Order workspace' } },
        { id: 'query', action: 'fill', locator: { kind: 'label', value: 'Search orders' }, value: 'Bluebird' },
        { id: 'search', action: 'assert', assertion: 'containsText', locator: { kind: 'testId', value: 'search-results' }, expected: 'ORD-1003' },
        { id: 'customer', action: 'fill', locator: { kind: 'label', value: 'Customer' }, value: 'Acme QA' },
        { id: 'priority', action: 'select', locator: { kind: 'label', value: 'Priority' }, value: 'high' },
        { id: 'submit', action: 'click', locator: { kind: 'role', role: 'button', name: 'Create order', value: 'Create order' } },
        { id: 'result', action: 'assert', assertion: 'containsText', locator: { kind: 'testId', value: 'order-result' }, expected: 'Order created for Acme QA with high priority.' },
      ],
    })
    const report = await runUiTestCase(testCase, { outputDirectory: join(process.cwd(), 'output') })
    expect(report.status).toBe('passed')
    expect(report.steps_passed).toBe(testCase.steps.length)
    expect(report.steps.find(step => step.id === 'customer')?.actual).toBe('[input value redacted]')
    expect(report.screenshots).toEqual([])
  })

  it('captures a failure screenshot and real error evidence', async () => {
    const testCase = validCase({
      case_id: 'ui-order-failure',
      name: 'Order failure path',
      target_url: `${origin}/`,
      allowed_origins: [origin],
      steps: [
        { id: 'open', action: 'navigate', url: `${origin}/` },
        { id: 'username', action: 'fill', locator: { kind: 'label', value: 'Username' }, value: 'demo' },
        { id: 'password', action: 'fill', locator: { kind: 'label', value: 'Password' }, value: 'demo123' },
        { id: 'login', action: 'click', locator: { kind: 'role', role: 'button', name: 'Open workspace', value: 'Open workspace' } },
        { id: 'customer', action: 'fill', locator: { kind: 'label', value: 'Customer' }, value: 'Acme QA' },
        { id: 'fail', action: 'click', locator: { kind: 'label', value: 'Simulate downstream failure' } },
        { id: 'submit', action: 'click', locator: { kind: 'role', role: 'button', name: 'Create order', value: 'Create order' } },
        { id: 'wrong-expectation', action: 'assert', assertion: 'containsText', locator: { kind: 'testId', value: 'order-result' }, expected: 'Order created' },
      ],
    })
    const report = await runUiTestCase(testCase, { outputDirectory: join(process.cwd(), 'output') })
    expect(report.status).toBe('failed')
    expect(report.steps_failed).toBe(1)
    expect(report.steps.at(-1)?.error).toContain('text assertion failed')
    expect(report.screenshots).toHaveLength(1)
    expect((await readFile(report.screenshots[0]!)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('marks a real browser run as cancelled when aborted', async () => {
    const testCase = validCase({
      case_id: 'ui-cancel',
      name: 'Cancelled UI run',
      target_url: `${origin}/`,
      allowed_origins: [origin],
      steps: [
        { id: 'open', action: 'navigate', url: `${origin}/` },
        { id: 'pause', action: 'wait', timeoutMs: 3000 },
      ],
    })
    const controller = new AbortController()
    const pending = runUiTestCase(testCase, { outputDirectory: join(process.cwd(), 'output'), signal: controller.signal })
    setTimeout(() => controller.abort(), 250)
    const report = await pending
    expect(report.status).toBe('cancelled')
    expect(report.finished_at).toBeDefined()
  })
})

function mime(path: string): string {
  const extension = extname(path)
  if (extension === '.css') return 'text/css'
  if (extension === '.js') return 'text/javascript'
  return 'text/html'
}
