import type { EnginePerformanceReport } from '../engines/report.ts'
import type { TestAgentReport } from '../results/result.ts'
import type { AgentTaskState, FailureAnalysis, ToolCallRecord } from './types.ts'
import type { JavaAnalysis } from '../code/types.ts'

export function analyzeTask(task: AgentTaskState): FailureAnalysis {
  const facts: string[] = []
  const inferences: FailureAnalysis['inferences'] = []
  const hypotheses: FailureAnalysis['hypotheses'] = []
  const recommendations: string[] = []
  const reports = task.tool_calls
    .filter(call => call.result !== undefined)
    .map(call => ({ call, report: parseReport(call.result) }))
    .filter((item): item is { call: ToolCallRecord; report: TestAgentReport | EnginePerformanceReport } => item.report !== undefined)
  const codeAnalyses = task.tool_calls
    .filter(call => call.result !== undefined)
    .map(call => ({ call, analysis: parseCodeAnalysis(call.result) }))
    .filter((item): item is { call: ToolCallRecord; analysis: JavaAnalysis } => item.analysis !== undefined)

  facts.push(`Task ${task.task_id} ended with status "${task.status}".`)
  facts.push(`${task.tool_calls.filter(call => call.status === 'succeeded').length} tool call(s) succeeded; ${task.tool_calls.filter(call => call.status === 'failed').length} failed.`)

  for (const { call, report } of reports) {
    if (isReplayReport(report)) {
      facts.push(`Replay report ${report.run_id}: ${report.total} request(s), ${report.passed} passed, ${report.failed} failed.`)
      for (const request of report.requests.filter(item => !item.passed)) {
        const error = request.error === undefined || request.error === `HTTP ${request.status}` ? '' : ` (${request.error})`
        facts.push(`${request.method} ${request.path} returned HTTP ${request.status}${error}.`)
      }
      const serverErrors = report.requests.filter(request => request.status >= 500)
      if (serverErrors.length > 0) {
        inferences.push({
          statement: 'The target service returned a server-side error for at least one request.',
          evidence: serverErrors.map(request => `${request.method} ${request.path} -> HTTP ${request.status}`).join('; '),
        })
        hypotheses.push({
          statement: 'The 5xx response may come from a downstream dependency, invalid test data, authentication state, or an application defect; the report alone cannot identify which.',
          verification: 'Read the target service logs for the corresponding request IDs and rerun the same request with authorized diagnostic tracing.',
        })
        recommendations.push('Trace the first 5xx request in authorized target logs and compare it with the replay request and response preview.')
      }
      for (const request of report.requests.filter(item => item.status === 0)) {
        inferences.push({
          statement: 'At least one request did not receive an HTTP response.',
          evidence: `${request.method} ${request.path}: ${request.error ?? 'unknown transport error'}`,
        })
        hypotheses.push({
          statement: 'The transport failure may reflect network policy, an unavailable fixture, DNS, or a timeout.',
          verification: 'Confirm the target process is running on the stated origin and rerun only the failed request from a network path with the same policy as production clients.',
        })
        recommendations.push('Verify the target origin is reachable and rerun only the transport-failed request before repeating the full sequence.')
      }
    } else {
      facts.push(`Engine report ${report.run_id}: status "${report.evidence.status}", ${report.metrics.total} request(s), ${report.metrics.passed} passed, ${report.metrics.failed} failed.`)
      for (const diagnostic of report.diagnostics) {
        facts.push(`Engine diagnostic (${diagnostic.category}): ${diagnostic.message}`)
      }
      if (report.evidence.error !== undefined) facts.push(`Engine evidence error: ${report.evidence.error}`)
      if (report.evidence.status === 'result_parse_error') {
        inferences.push({
          statement: 'The engine ran but its raw result could not be parsed into the unified report.',
          evidence: report.evidence.error ?? 'result_parse_error',
        })
        recommendations.push('Inspect the raw result artifact and engine stderr before treating the run as a product failure.')
      }
      if (report.evidence.status === 'not_installed' || /not installed|unavailable/i.test(report.evidence.error ?? '')) {
        inferences.push({
          statement: 'The execution environment could not start the selected engine.',
          evidence: report.evidence.error ?? report.evidence.status,
        })
        recommendations.push('Install the engine or set TEST_AGENT_K6_PATH / TEST_AGENT_JMETER_PATH, then rerun.')
      }
      if (report.metrics.failed > 0 && report.metrics.total > 0) {
        hypotheses.push({
          statement: 'Engine failures may be caused by target behavior, generated-script errors, or correlation data; aggregate metrics alone do not identify the cause.',
          verification: 'Compare the engine stderr, raw result rows, and a single-request API replay for the first failing request.',
        })
      }
    }
  }

  for (const call of task.tool_calls.filter(item => item.status === 'failed')) {
    facts.push(`Tool ${call.tool} on step ${call.step_id} failed: ${call.error ?? 'no error detail recorded'}.`)
    inferences.push({
      statement: `The failure occurred before ${call.tool} produced a successful auditable result.`,
      evidence: call.error ?? call.status,
    })
  }
  for (const { analysis } of codeAnalyses) {
    facts.push(`Java ${analysis.mode} analysis ${analysis.analysis_id}: ${analysis.structure.source_files} source file(s), ${analysis.classes.length} class(es), ${analysis.endpoints.length} endpoint declaration(s), ${analysis.branches.length} branch candidate(s).`)
    for (const endpoint of analysis.endpoints.slice(0, 20)) {
      facts.push(`${endpoint.http_method} ${endpoint.path} maps to ${endpoint.class_name}.${endpoint.method} at ${endpoint.evidence.file}:${endpoint.evidence.line ?? '?'} (static).`)
    }
    for (const uncertainty of analysis.uncertainties.slice(0, 10)) {
      facts.push(`Analysis limitation (${uncertainty.kind}): ${uncertainty.message}`)
    }
    if (analysis.branches.length > 0) {
      inferences.push({
        statement: 'Static branches without matching executed evidence are candidate test points, not proven coverage gaps.',
        evidence: `${analysis.branches.length} branch candidate(s) were extracted from ${analysis.mode} analysis.`,
      })
      hypotheses.push({
        statement: 'Some static branches may be unreachable in production because of framework routing, configuration, or dynamic dispatch.',
        verification: 'Generate explicit test data for one branch at a time and obtain runtime coverage before marking it covered.',
      })
    }
    if (analysis.coverage.measured === false) {
      facts.push(`No runtime coverage was attached to ${analysis.analysis_id}; no coverage percentage is available.`)
    }
  }

  if (task.status === 'cancelled') {
    facts.push('The task received a cancellation request; completed steps remain recorded.')
    recommendations.push('Review completed and running steps before choosing to resume; do not repeat completed side-effecting steps.')
  }
  if (task.status === 'interrupted') {
    facts.push('The task was interrupted before the execution process recorded a terminal status.')
    recommendations.push('Use resume to inspect uncertain steps; confirm retries only after checking external side effects.')
  }
  if (facts.length === 1) facts.push('No tool report was recorded.')
  if (inferences.length === 0) {
    inferences.push({
      statement: 'No failure cause is supported by the recorded evidence.',
      evidence: 'All recorded tool calls and reports were inspected.',
    })
  }
  if (hypotheses.length === 0) {
    hypotheses.push({
      statement: 'No unverified failure hypothesis is warranted from the current result.',
      verification: 'No additional verification is required unless new evidence appears.',
    })
  }
  if (recommendations.length === 0) {
    recommendations.push(
      task.status === 'succeeded'
        ? 'Keep the report and raw evidence with the run ID for regression comparison.'
        : 'Resolve the recorded tool error, then resume from the first incomplete step.',
    )
  }

  return {
    model_status: 'not_requested',
    facts,
    inferences,
    hypotheses,
    recommendations,
  }
}

export function renderFailureAnalysis(analysis: FailureAnalysis): string {
  return [
    'Facts',
    ...analysis.facts.map(item => `- ${item}`),
    '',
    'Inferences',
    ...analysis.inferences.map(item => `- ${item.statement} Evidence: ${item.evidence}`),
    '',
    'Unverified hypotheses',
    ...analysis.hypotheses.map(item => `- ${item.statement} Verification: ${item.verification}`),
    '',
    'Recommendations',
    ...analysis.recommendations.map(item => `- ${item}`),
    ...analysis.model_status === 'unavailable'
      ? ['', `Model enrichment unavailable: ${analysis.model_error ?? 'unknown model failure'}`]
      : [],
  ].join('\n')
}

function parseReport(value: unknown): TestAgentReport | EnginePerformanceReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['run_id'] !== 'string') return undefined
  if (record['engine'] !== undefined && record['metrics'] !== undefined && record['evidence'] !== undefined) {
    return value as EnginePerformanceReport
  }
  if (record['total'] !== undefined && record['requests'] !== undefined) {
    return value as TestAgentReport
  }
  return undefined
}

function parseCodeAnalysis(value: unknown): JavaAnalysis | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['schema_version'] !== 'test-agent.java-analysis/v1') return undefined
  if (!Array.isArray(record['classes']) || !Array.isArray(record['endpoints']) || !Array.isArray(record['branches'])) return undefined
  return value as JavaAnalysis
}

function isReplayReport(report: TestAgentReport | EnginePerformanceReport): report is TestAgentReport {
  return 'requests' in report
}
