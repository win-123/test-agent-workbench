#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseHar } from '../har/parser.ts'
import { DEFAULT_ALLOWED_ORIGINS } from '../api/policy.ts'
import { replayHar } from '../api/replay.ts'
import type { AssertionConfig } from '../api/assertions.ts'
import { generateK6Script } from '../generators/k6.ts'
import { generateJmx } from '../generators/jmeter.ts'
import { generatePostmanCollection } from '../generators/postman.ts'
import { createReport } from '../results/result.ts'
import { runEngine } from '../engines/executor.ts'
import { createEngineReport } from '../engines/report.ts'
import type { CorrelationConfig } from '../generators/k6.ts'
import { agentCommand } from './agent.ts'
import { uiCommand } from './ui.ts'
import { codeCommand } from './code.ts'
import { assetCommand, coverageCommand } from './asset-coverage.ts'


export async function main(rawArgv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArguments(rawArgv)
  const command = args[0]
  try {
    if (command === 'har' && args[1] === 'inspect') await inspectHar(args[2] ?? '')
    else if (command === 'api' && args[1] === 'replay') await replayCommand(args.slice(2))
    else if (command === 'generate') await generateCommand(args.slice(1))
    else if (command === 'engine') await engineCommand(args.slice(1))
    else if (command === 'report') await reportCommand(args.slice(1))
    else if (command === 'agent') await agentCommand(args.slice(1))
    else if (command === 'ui') await uiCommand(args.slice(1))
    else if (command === 'code') await codeCommand(args.slice(1))
    else if (command === 'asset') await assetCommand(args.slice(1))
    else if (command === 'coverage') await coverageCommand(args.slice(1))
    else printHelp()
  } catch (error) {
    console.error(`test-agent: ${(error as Error).message}`)
    return 1
  }
  // Subcommands communicate test failures through process.exitCode; preserve it
  // instead of overwriting a failed replay/UI/engine result with success.
  return Number(process.exitCode ?? 0) || 0
}

async function inspectHar(path: string): Promise<void> {
  const har = parseHar(await readFile(path, 'utf8'))
  console.log(JSON.stringify({
    total: har.entries.length,
    requests: har.entries.map(request => ({
      order: request.order,
      method: request.method,
      origin: request.origin,
      path: request.path,
      query: request.query,
      headers: request.headers,
    })),
  }, null, 2))
}

async function replayCommand(argv: string[]): Promise<void> {
  const path = requireArg(argv[0] ?? '')
  const baseUrl = requireOption(argv, '--base-url')
  const timeoutMs = parsePositiveInteger(option(argv, '--timeout-ms'), 5000, '--timeout-ms')
  const concurrency = parsePositiveInteger(option(argv, '--concurrency'), 1, '--concurrency')
  const assertionsPath = option(argv, '--assertions')
  const assertions = assertionsPath === undefined ? [] : readAssertions(assertionsPath)
  const correlationsPath = option(argv, '--correlations')
  const correlations = correlationsPath === undefined ? [] : readCorrelations(correlationsPath)
  const har = parseHar(await readFile(path, 'utf8'))
  const result = await replayHar(har, {
    baseUrl,
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    timeoutMs,
    concurrency,
    assertions,
    correlations,
  })
  const report = createReport(
    result,
    {},
    { base_url: baseUrl, timeout_ms: timeoutMs, max_entries: 100, concurrency, assertions_file: assertionsPath, correlations_file: correlationsPath },
    result.startedAt,
    result.finishedAt,
  )
  await saveReport(report)
  console.log(JSON.stringify(report, null, 2))
  if (report.failed > 0) process.exitCode = 1
}

async function generateCommand(argv: string[]): Promise<void> {
  const engine = (argv[0] ?? '')
  const harPath = requireArg(argv[1] ?? '')
  const baseUrl = requireOption(argv, '--base-url')
  const har = parseHar(await readFile(harPath, 'utf8'))
  const outputDir = join(process.cwd(), 'output')
  await mkdir(outputDir, { recursive: true })
  if (engine === 'k6') {
    const file = join(outputDir, `test-agent-${timestamp()}.js`)
    await writeFile(file, generateK6Script(har, { baseUrl }))
    console.log(file)
  } else if (engine === 'jmeter') {
    const file = join(outputDir, `test-agent-${timestamp()}.jmx`)
    await writeFile(file, generateJmx(har, { baseUrl }))
    console.log(file)
  } else if (engine === 'postman') {
    const file = join(outputDir, `test-agent-${timestamp()}.postman.json`)
    await writeFile(file, generatePostmanCollection(har, { baseUrl }))
    console.log(file)
  } else {
    throw new Error(`unknown generator: ${engine}`)
  }
}

async function engineCommand(argv: string[]): Promise<void> {
  const engine = argv[0] ?? ''
  if (engine !== 'k6' && engine !== 'jmeter') throw new Error(`unknown engine: ${engine}`)
  const harPath = requireArg(argv[1] ?? '')
  const baseUrl = requireOption(argv, '--base-url')
  const vus = parsePositiveInteger(option(argv, '--vus'), 1, '--vus')
  const duration = option(argv, '--duration')
  const iterations = parsePositiveInteger(option(argv, '--iterations'), 1, '--iterations')
  const timeoutMs = parsePositiveInteger(option(argv, '--timeout-ms'), 60000, '--timeout-ms')
  const assertionsPath = option(argv, '--assertions')
  const correlationsPath = option(argv, '--correlations')
  const assertions = assertionsPath === undefined ? [] : readAssertions(assertionsPath)
  const correlations = correlationsPath === undefined ? [] : readCorrelations(correlationsPath)
  const har = parseHar(await readFile(harPath, 'utf8'))
  const outputDir = join(process.cwd(), 'output')
  await mkdir(outputDir, { recursive: true })
  const runId = `engine_${timestamp()}_${Math.random().toString(16).slice(2, 8)}`
  const scriptPath = join(outputDir, `${runId}.${engine === 'k6' ? 'js' : 'jmx'}`)
  if (engine === 'k6') {
    await writeFile(scriptPath, generateK6Script(har, { baseUrl, vus, iterations, duration, assertions, correlations }))
  } else {
    await writeFile(scriptPath, generateJmx(har, {
      baseUrl,
      threads: vus,
      loops: iterations,
      durationSeconds: parseDuration(duration, 'seconds'),
      correlations,
    }))
  }
  const execution = await runEngine({ kind: engine, scriptPath, timeoutMs, outputDirectory: outputDir, runId })
  const report = await createEngineReport(execution, { concurrency: vus, duration, iterations })
  await writeFile(join(outputDir, `${runId}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.evidence.status !== 'passed' || report.metrics.failed > 0) process.exitCode = 1
}

async function reportCommand(argv: string[]): Promise<void> {
  const runId = option(argv, '--run-id') ?? argv[0] ?? ''
  if (runId.length === 0) throw new Error('missing required option --run-id')
  const dir = join(process.cwd(), 'output')
  const entries = await readdir(dir)
  const file = entries.find(name => name.startsWith(`${runId}.json`))
  if (file === undefined) throw new Error(`report not found: ${runId}`)
  console.log(await readFile(join(dir, file), 'utf8'))
}

async function saveReport(report: { run_id: string }): Promise<void> {
  const dir = join(process.cwd(), 'output')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${report.run_id}.json`), JSON.stringify(report, null, 2))
}

function printHelp(): void {
  console.log(`test-agent commands:
  test-agent har inspect <har-file>
  test-agent api replay <har-file> --base-url <url> [--assertions <file>] [--correlations <file>]
  test-agent generate k6 <har-file> --base-url <url>
  test-agent generate jmeter <har-file> --base-url <url>
  test-agent generate postman <har-file> --base-url <url>
  test-agent engine k6 <har-file> --base-url <url> [options]
  test-agent engine jmeter <har-file> --base-url <url> [options]
  test-agent report --run-id <id>
  test-agent agent --help
  test-agent ui --help
  test-agent code --help
  test-agent asset --help
  test-agent coverage --help`)
}

function readAssertions(path: string): AssertionConfig[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`invalid assertions file ${path}: ${(error as Error).message}`)
  }
  if (!Array.isArray(parsed) || !parsed.every(item => item !== null && typeof item === 'object')) {
    throw new Error('assertions file must contain a JSON array of objects')
  }
  return parsed as AssertionConfig[]
}

function readCorrelations(path: string): CorrelationConfig[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`invalid correlations file ${path}: ${(error as Error).message}`)
  }
  if (!Array.isArray(parsed) || !parsed.every(item => item !== null && typeof item === 'object')) {
    throw new Error('correlations file must contain a JSON array of objects')
  }
  return parsed as CorrelationConfig[]
}

function requireArg(value: string): string {
  if (value.length === 0) throw new Error('missing required argument')
  return resolve(value)
}

function requireOption(argv: string[], name: string): string {
  const aliases = optionAliases(name)
  const value = aliases.flatMap(alias => option(argv, alias)).find(item => item !== undefined)
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required option ${name}`)
  }
  return value
}

function option(argv: string[], name: string): string | undefined {
  const aliases = optionAliases(name)
  const exactIndex = aliases.map(alias => argv.indexOf(alias)).find(index => index >= 0)
  if (exactIndex !== undefined) return argv[exactIndex + 1]
  const prefixed = aliases.flatMap(alias => argv.find(arg => arg.startsWith(`${alias}=`)))
  return prefixed.find(value => value !== undefined)?.slice((prefixed.find(value => value !== undefined) ?? '').indexOf('=') + 1)
}

function optionAliases(name: string): string[] {
  return [name, `-${name.slice(2)}`]
}

function parseArguments(raw: string[]): string[] {
  // Node may normalize POSIX CLI options to result-only form (for example
  // `--base-url=x` can become `-base-url=x`); normalize both spellings here.
  return raw.map(arg => arg.length > 1 && arg.startsWith('-') && !arg.startsWith('--') && /^-base-(?:url|run-id|timeout-ms)=/.test(arg)
    ? `-${arg}`
    : arg)
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function parseDuration(value: string | undefined, unit: 'seconds'): number | undefined {
  if (value === undefined) return undefined
  const match = value.match(/^(\d+)(s|m)?$/)
  if (match === null) throw new Error(`duration must be like 30s or 2m`)
  const amount = Number(match[1])
  if (amount <= 0) throw new Error('duration must be positive')
  return unit === 'seconds' ? (match[2] === 'm' ? amount * 60 : amount) : undefined
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}
