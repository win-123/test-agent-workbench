import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parseHar } from '../har/parser.ts'
import { DEFAULT_ALLOWED_ORIGINS } from '../api/policy.ts'
import { replayHar } from '../api/replay.ts'
import type { AssertionConfig } from '../api/assertions.ts'
import { generateJmx } from '../generators/jmeter.ts'
import { generateK6Script } from '../generators/k6.ts'
import { createReport, toJsonValue } from '../results/result.ts'
import { registerAgentTools } from './agent-tools.ts'

export const name = 'test-agent'
export const inject = ['tools']

export function apply(ctx: Context): void {
  registerAgentTools(ctx)

  ctx.tools.register(defineTool({
    name: 'test_har_inspect',
    description: 'Inspect a sanitized HAR 1.2 file without replaying requests.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the HAR file' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { path: string }) {
      return { total: parseHar(await readFile(args.path, 'utf8')).entries.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_api_replay',
    description: 'Replay sanitized HAR requests against an explicitly whitelisted target origin.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the HAR file' },
      base_url: { type: 'string', required: true, description: 'Explicit target base URL' },
      assertions: { type: 'json', description: 'Optional assertion configuration array' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { path: string; base_url: string; assertions?: unknown }, exec: ToolRunContext) {
      const har = parseHar(await readFile(args.path, 'utf8'))
      const replay = await replayHar(har, {
        baseUrl: args.base_url,
        allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
        assertions: validateAssertions(args.assertions),
      }, exec.signal)
      const report = createReport(replay, {}, {
        allowed_origins: DEFAULT_ALLOWED_ORIGINS,
        assertions: validateAssertions(args.assertions),
      }, replay.startedAt, replay.finishedAt)
      return toJsonValue(report)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'test_script_generate',
    description: 'Generate a k6 JavaScript or JMeter JMX script from a sanitized HAR file.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to the HAR file' },
      base_url: { type: 'string', required: true, description: 'Target base URL' },
      engine: { type: 'string', required: true, description: 'Engine: k6 or jmeter' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { path: string; base_url: string; engine: string }) {
      const har = parseHar(await readFile(args.path, 'utf8'))
      if (args.engine === 'k6') return { script: generateK6Script(har, { baseUrl: args.base_url, allowedOrigins: DEFAULT_ALLOWED_ORIGINS }) }
      if (args.engine === 'jmeter') return { script: generateJmx(har, { baseUrl: args.base_url, allowedOrigins: DEFAULT_ALLOWED_ORIGINS }) }
      throw new Error(`unknown engine: ${args.engine}`)
    },
  }))
}

function validateAssertions(value: unknown): AssertionConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => item !== null && typeof item === 'object')) {
    throw new Error('assertions must be an array of objects')
  }
  return value as AssertionConfig[]
}
