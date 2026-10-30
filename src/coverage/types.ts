import type { CodeEvidence, JavaAnalysis, JavaBranch } from '../code/types.ts'

export const COVERAGE_SCHEMA_VERSION = 'test-agent.coverage-analysis/v1' as const
export const RUNTIME_COVERAGE_SCHEMA_VERSION = 'test-agent.runtime-coverage/v1' as const

export interface RuntimeCoverageBranch {
  file: string
  line: number
  covered: boolean
}

export interface RuntimeCoverageInput {
  schema_version: typeof RUNTIME_COVERAGE_SCHEMA_VERSION
  tool: string
  measured_at: string
  branches: RuntimeCoverageBranch[]
}

export interface CoverageBranchState {
  branch: JavaBranch
  runtime: 'covered' | 'uncovered' | 'not_measured'
}

export interface CoverageMeasurement {
  measured: boolean
  tool?: string
  measured_at?: string
  matched_branches: number
  covered_branches: number
  percentage: number | null
  note: string
}

export interface EndpointTestLink {
  endpoint: JavaAnalysis['endpoints'][number]
  implementation: CodeEvidence
  asset_ids: string[]
  run_ids: string[]
  evidence: 'static-mapping' | 'runtime-evidence'
}

export interface CandidateBasis {
  evidence_type: 'static' | 'runtime'
  evidence: CodeEvidence[]
}

export interface TestCandidate {
  candidate_id: string
  title: string
  kind: 'api' | 'ui' | 'performance' | 'manual'
  priority: 'high' | 'medium' | 'low'
  basis: CandidateBasis
  hypothesis: {
    statement: string
    verification: string
  }
  proposed_test: {
    http_method?: string
    path?: string
    request_order?: number
    steps?: string[]
  }
  executable_asset_id?: string
  coverage_assertion: 'not_measured' | 'runtime_covered' | 'runtime_uncovered'
  execution?: {
    task_id: string
    run_id?: string
    status: string
    report_path?: string
    completed_at: string
  }
  created_at: string
}

export interface CoverageAnalysis {
  schema_version: typeof COVERAGE_SCHEMA_VERSION
  analysis_id: string
  code_analysis_id: string
  created_at: string
  measurement: CoverageMeasurement
  branch_states: CoverageBranchState[]
  links: EndpointTestLink[]
  candidates: TestCandidate[]
  limitations: string[]
}

export interface CoverageAnalysisSummary {
  analysis_id: string
  code_analysis_id: string
  created_at: string
  measurement: CoverageMeasurement
  candidates: TestCandidate[]
  path: string
}
