import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseHar } from '../har/parser.ts'
import { replayHar } from '../api/replay.ts'
import { createTargetPolicy, DEFAULT_ALLOWED_ORIGINS } from '../api/policy.ts'
import type { AssertionConfig } from '../api/assertions.ts'
import { generateK6Script, type CorrelationConfig } from '../generators/k6.ts'
import { generateJmx } from '../generators/jmeter.ts'
import { createReport } from '../results/result.ts'
import { runEngine } from '../engines/executor.ts'
import { createEngineReport } from '../engines/report.ts'
import type { EngineKind } from '../engines/types.ts'
import { analyzeJavaInput } from '../code/java-analyzer.ts'
import { resolveInside } from '../desktop/security.ts'
import {
  AGENT_TOOL_NAMES,
  type AgentToolName,
  type PlanValidationIssue,
  type TestPlanStep,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from './types.ts'

export interface AgentTool {
  name: AgentToolName
  description: string
  sideEffects: boolean
  validate(args: Record<string, unknown>): PlanValidationIssue[]
  execute(context: ToolExecutionContext): Promise<ToolExecutionResult>
}

export interface ToolCatalog {
  list(): AgentTool[]
  get(name: string): AgentTool | undefined
  execute(context: ToolExecutionContext): Promise<ToolExecutionResult>
}

export interface ToolCatalogOptions {
  outputDir: string
  engineExecutables?: Partial<Record<EngineKind, string>>
  allowedInputRoots?: string[]
}

export function createDefaultToolCatalog(options: ToolCatalogOptions): ToolCatalog {
  const tools = buildDefaultTools(options)
  const byName = new Map<string, AgentTool>(tools.map(tool => [tool.name, tool]))
  return {
    list: () => [...tools],
    get: name => byName.get(name),
    async execute(context) {
      const tool = byName.get(context.step.tool)
      if (tool === undefined) throw new Error(`tool is not allowlisted: ${context.step.tool}`)
      context.signal.throwIfAborted()
      return await tool.execute(context)
    },
  }
}

function buildDefaultTools(options: ToolCatalogOptions): AgentTool[] {
  return [
    {
      name: 'har.inspect',
      description: 'Inspect a sanitized HAR without sending requests.',
      sideEffects: false,
      validate: validatePath,
      async execute(context) {
        const path = resolvePath(context.step.arguments['path'], context)
        const har = parseHar(await readFile(path, 'utf8'))
        return {
          summary: {
            total: har.entries.length,
            methods: har.entries.map(entry => entry.method),
            paths: har.entries.map(entry => entry.path),
          },
          result: {
            total: har.entries.length,
            requests: har.entries.map(entry => ({
              order: entry.order,
              method: entry.method,
              path: entry.path,
              headers: entry.headers,
            })),
          },
          artifacts: [],
          runIds: [],
          testFailure: false,
        }
      },
    },
    {
      name: 'api.replay',
      description: 'Replay sanitized HAR requests through the existing API replay path.',
      sideEffects: true,
      validate: validatePath,
      async execute(context) {
        context.signal.throwIfAborted()
        const path = resolvePath(context.step.arguments['path'], context)
        const baseUrl = context.plan.target.base_url
        const allowedOrigins = context.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS
        const timeoutMs = positiveInteger(context.step.arguments['timeout_ms']) ?? 5000
        const concurrency = positiveInteger(context.step.arguments['concurrency']) ?? 1
        const assertions = context.step.assertions as AssertionConfig[]
        createTargetPolicy(baseUrl, allowedOrigins)
        const har = parseHar(await readFile(path, 'utf8'))
        const replay = await replayHar(har, {
          baseUrl,
          allowedOrigins,
          allowedPaths: context.plan.target.allowed_paths,
          timeoutMs,
          concurrency,
          assertions,
        }, context.signal)
        const report = createReport(replay, {}, {
          base_url: baseUrl,
          timeout_ms: timeoutMs,
          concurrency,
          assertions,
        }, replay.startedAt, replay.finishedAt)
        const reportPath = join(context.artifactDir, `${report.run_id}.report.json`)
        await writeJson(reportPath, report)
        return {
          summary: {
            run_id: report.run_id,
            total: report.total,
            passed: report.passed,
            failed: report.failed,
            report_path: reportPath,
          },
          result: report,
          artifacts: [reportPath],
          runIds: [report.run_id],
          testFailure: report.failed > 0,
        }
      },
    },
    {
      name: 'script.generate.k6',
      description: 'Generate a k6 script using the existing generator.',
      sideEffects: false,
      validate: validatePath,
      async execute(context) {
    const har = parseHar(await readFile(resolvePath(context.step.arguments['path'], context), 'utf8'))
        const script = generateK6Script(har, {
          baseUrl: context.plan.target.base_url,
          allowedOrigins: context.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS,
          assertions: context.step.assertions as AssertionConfig[],
          correlations: readCorrelations(context.step.arguments['correlations']),
        })
        const scriptPath = join(context.artifactDir, `${safeStepId(context.step)}.k6.js`)
        await writeFile(scriptPath, script)
        return {
          summary: { engine: 'k6', script_path: scriptPath, bytes: Buffer.byteLength(script) },
          result: { script_path: scriptPath },
          artifacts: [scriptPath],
          runIds: [],
          testFailure: false,
        }
      },
    },
    {
      name: 'script.generate.jmeter',
      description: 'Generate a JMeter JMX script using the existing generator.',
      sideEffects: false,
      validate: validatePath,
      async execute(context) {
    const har = parseHar(await readFile(resolvePath(context.step.arguments['path'], context), 'utf8'))
        const script = generateJmx(har, {
          baseUrl: context.plan.target.base_url,
          allowedOrigins: context.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS,
          threads: positiveInteger(context.step.arguments['vus']),
          loops: positiveInteger(context.step.arguments['iterations']),
          durationSeconds: durationSeconds(context.step.arguments['duration']),
          correlations: readCorrelations(context.step.arguments['correlations']),
        })
        const scriptPath = join(context.artifactDir, `${safeStepId(context.step)}.jmx`)
        await writeFile(scriptPath, script)
        return {
          summary: { engine: 'jmeter', script_path: scriptPath, bytes: Buffer.byteLength(script) },
          result: { script_path: scriptPath },
          artifacts: [scriptPath],
          runIds: [],
          testFailure: false,
        }
      },
    },
    {
      name: 'engine.run.k6',
      description: 'Generate and execute a real k6 run, then build the existing unified report.',
      sideEffects: true,
      validate: validatePath,
      execute: context => executeEngine('k6', context, options),
    },
    {
      name: 'engine.run.jmeter',
      description: 'Generate and execute a real JMeter run, then build the existing unified report.',
      sideEffects: true,
      validate: validatePath,
      execute: context => executeEngine('jmeter', context, options),
    },
    {
      name: 'report.read',
      description: 'Read an existing JSON report from the output directory or task artifact directory.',
      sideEffects: false,
      validate(args) {
        const issues: PlanValidationIssue[] = []
        if (args['run_id'] === undefined && args['path'] === undefined) {
          issues.push(toolIssue('missing_report_reference', 'run_id or path is required'))
        }
        if (args['run_id'] !== undefined && (typeof args['run_id'] !== 'string' || args['run_id'].length === 0)) {
          issues.push(toolIssue('invalid_run_id', 'run_id must be a non-empty string'))
        }
        if (args['path'] !== undefined && typeof args['path'] !== 'string') {
          issues.push(toolIssue('invalid_path', 'path must be a string'))
        }
        return issues
      },
      async execute(context) {
        const reportPath = await resolveReportPath(context, options.outputDir)
        const raw = await readFile(reportPath, 'utf8')
        let report: unknown
        try {
          report = JSON.parse(raw) as unknown
        } catch (error) {
          throw new Error(`invalid report JSON: ${(error as Error).message}`)
        }
        return {
          summary: { report_path: reportPath, bytes: Buffer.byteLength(raw) },
          result: report,
          artifacts: [reportPath],
          runIds: readRunId(report),
          testFailure: reportHasFailures(report),
        }
      },
    },
    {
      name: 'code.analyze.java',
      description: 'Analyze authorized Java source, a WAR, or a class file and record deterministic evidence.',
      sideEffects: false,
      validate: validatePath,
      async execute(context) {
        context.signal.throwIfAborted()
        const path = resolvePath(context.step.arguments['path'], context)
        const analysis = await analyzeJavaInput(path)
        const analysisPath = join(context.artifactDir, `${analysis.analysis_id}.java-analysis.json`)
        await writeJson(analysisPath, analysis)
        return {
          summary: {
            analysis_id: analysis.analysis_id,
            mode: analysis.mode,
            classes: analysis.classes.length,
            endpoints: analysis.endpoints.length,
            branches: analysis.branches.length,
            uncertainties: analysis.uncertainties.length,
            analysis_path: analysisPath,
          },
          result: analysis,
          artifacts: [analysisPath],
          runIds: [],
          testFailure: false,
        }
      },
    },
  ]
}

async function executeEngine(kind: EngineKind, context: ToolExecutionContext, options: ToolCatalogOptions): Promise<ToolExecutionResult> {
  context.signal.throwIfAborted()
  const har = parseHar(await readFile(resolvePath(context.step.arguments['path'], context), 'utf8'))
  const runId = `engine_${timestamp()}_${context.taskId.slice(0, 12)}_${safeStepId(context.step)}`
  const scriptPath = join(context.artifactDir, `${runId}.${kind === 'k6' ? 'js' : 'jmx'}`)
  const iterations = positiveInteger(context.step.arguments['iterations']) ?? 1
  const vus = positiveInteger(context.step.arguments['vus']) ?? 1
  const duration = typeof context.step.arguments['duration'] === 'string' ? context.step.arguments['duration'] : undefined
  const timeoutMs = positiveInteger(context.step.arguments['timeout_ms']) ?? 60000
  const assertions = context.step.assertions as AssertionConfig[]
  const correlations = readCorrelations(context.step.arguments['correlations'])
  if (kind === 'k6') {
    await writeFile(scriptPath, generateK6Script(har, {
      baseUrl: context.plan.target.base_url,
      allowedOrigins: context.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS,
      vus,
      iterations,
      duration,
      assertions,
      correlations,
    }))
  } else {
    await writeFile(scriptPath, generateJmx(har, {
      baseUrl: context.plan.target.base_url,
      allowedOrigins: context.plan.target.allowed_origins ?? DEFAULT_ALLOWED_ORIGINS,
      threads: vus,
      loops: iterations,
      durationSeconds: durationSeconds(duration),
      correlations,
    }))
  }
  const execution = await runEngine({
    kind,
    scriptPath,
    timeoutMs,
    outputDirectory: context.artifactDir,
    runId,
    executable: options.engineExecutables?.[kind],
    signal: context.signal,
  })
  const report = await createEngineReport(execution, { concurrency: vus, duration, iterations })
  const reportPath = join(context.artifactDir, `${runId}.report.json`)
  await writeJson(reportPath, report)
  return {
    summary: {
      run_id: runId,
      engine: kind,
      status: report.evidence.status,
      total: report.metrics.total,
      passed: report.metrics.passed,
      failed: report.metrics.failed,
      report_path: reportPath,
    },
    result: report,
    artifacts: [scriptPath, reportPath, execution.stdoutPath, execution.stderrPath, ...(execution.rawResultPath ? [execution.rawResultPath] : [])],
    runIds: [runId],
    testFailure: report.evidence.status !== 'passed' || report.metrics.failed > 0,
  }
}

function validatePath(args: Record<string, unknown>): PlanValidationIssue[] {
  const path = args['path']
  if (typeof path !== 'string' || path.trim().length === 0) {
    return [toolIssue('missing_path', 'path must be a non-empty string')]
  }
  return []
}

async function resolveReportPath(context: ToolExecutionContext, outputDir: string): Promise<string> {
  const runId = context.step.arguments['run_id']
  if (typeof runId === 'string' && runId.length > 0) {
    const candidates = [
      assertReadablePath(join(outputDir, `${runId}.json`), [outputDir]),
      assertReadablePath(join(context.artifactDir, `${runId}.report.json`), [context.artifactDir]),
    ]
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Try the next supported report location.
      }
    }
    throw new Error(`report not found for run_id: ${runId}`)
  }
  return assertReadablePath(resolvePath(context.step.arguments['path'], context), [outputDir, context.artifactDir])
}

function assertReadablePath(path: string, roots: string[]): string {
  const normalized = resolve(path)
  const allowed = roots.some(root => {
    const relativePath = relative(resolve(root), normalized)
    return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
  })
  if (!allowed) throw new Error(`report path is outside allowed directories: ${normalized}`)
  return normalized
}

function readCorrelations(value: unknown): CorrelationConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('correlations must be an array')
  return value as CorrelationConfig[]
}

function resolvePath(value: unknown, context: ToolExecutionContext): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('path must be a non-empty string')
  const candidate = resolve(value)
  for (const root of [context.workingDirectory, ...context.allowedInputRoots]) {
    try {
      return resolveInside(root, candidate)
    } catch {
      // Try the next explicitly authorized root.
    }
  }
  throw new Error(`path is outside authorized input roots: ${candidate}`)
}

function positiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('value must be a positive integer')
  return Number(value)
}

function durationSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('duration must be a string')
  const match = value.match(/^(\d+)(s|m)$/)
  if (match === null) throw new Error('duration must be like 30s or 2m')
  const amount = Number(match[1])
  return match[2] === 'm' ? amount * 60 : amount
}

function safeStepId(step: TestPlanStep): string {
  return step.id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2))
}

function readRunId(report: unknown): string[] {
  if (report !== null && typeof report === 'object' && !Array.isArray(report)) {
    const runId = (report as Record<string, unknown>)['run_id']
    if (typeof runId === 'string') return [runId]
  }
  return []
}

function reportHasFailures(report: unknown): boolean {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return false
  const record = report as Record<string, unknown>
  const evidence = record['evidence']
  if (evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const status = (evidence as Record<string, unknown>)['status']
    if (typeof status === 'string' && status !== 'passed') return true
  }
  const metrics = record['metrics']
  if (metrics !== null && typeof metrics === 'object' && !Array.isArray(metrics)) {
    const failed = (metrics as Record<string, unknown>)['failed']
    if (typeof failed === 'number' && failed > 0) return true
  }
  const failed = record['failed']
  return typeof failed === 'number' && failed > 0
}

function toolIssue(code: string, message: string): PlanValidationIssue {
  return { code, path: 'arguments', message }
}

export function toolNames(): readonly AgentToolName[] {
  return AGENT_TOOL_NAMES
}
