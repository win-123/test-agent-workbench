export const JAVA_ANALYSIS_SCHEMA_VERSION = 'test-agent.java-analysis/v1' as const

export type EvidenceConfidence = 'static' | 'bytecode' | 'uncertain'

export interface CodeEvidence {
  file: string
  line?: number
  class_name?: string
  method?: string
}

export interface JavaProjectStructure {
  root: string
  source_roots: string[]
  source_files: number
  packages: string[]
  build_files: string[]
  frameworks: string[]
}

export interface JavaParameter {
  name: string
  type: string
  annotations: string[]
}

export interface JavaMethodInfo {
  class_name: string
  name: string
  signature: string
  descriptor?: string
  file?: string
  line?: number
  end_line?: number
  parameters: JavaParameter[]
  annotations: string[]
  calls: JavaCall[]
  branches: JavaBranch[]
  exceptions: JavaException[]
  confidence: EvidenceConfidence
}

export interface JavaClassInfo {
  name: string
  package: string
  kind: 'class' | 'interface' | 'enum' | 'record' | 'annotation' | 'unknown'
  file?: string
  line?: number
  annotations: string[]
  super_class?: string
  interfaces: string[]
  methods: JavaMethodInfo[]
  confidence: EvidenceConfidence
}

export interface JavaEndpoint {
  http_method: string
  path: string
  class_name: string
  method: string
  parameters: JavaParameter[]
  request_body: boolean
  evidence: CodeEvidence
}

export interface JavaCall {
  caller_class: string
  caller_method: string
  target: string
  line?: number
  resolved: boolean
  dynamic: boolean
  /** Source argument expressions; they are evidence, not evaluated runtime values. */
  arguments?: string[]
  /** Bytecode descriptors provide types only, not runtime argument values. */
  parameter_types?: string[]
  parameter_evidence?: 'source-text' | 'bytecode-descriptor'
  evidence: CodeEvidence
}

export type JavaBranchKind = 'if' | 'else' | 'switch' | 'case' | 'loop' | 'ternary' | 'catch'

export interface JavaBranch {
  id: string
  class_name: string
  method: string
  kind: JavaBranchKind
  line?: number
  condition: string
  risk: 'low' | 'medium' | 'high'
  evidence: CodeEvidence
}

export interface JavaException {
  class_name: string
  method: string
  kind: 'throw' | 'catch'
  line?: number
  type?: string
  message: string
  evidence: CodeEvidence
}

export interface JavaUncertainty {
  kind: 'dynamic-dispatch' | 'reflection' | 'missing-dependency' | 'obfuscation' | 'unsupported-syntax' | 'bytecode-limit' | 'archive-limit'
  message: string
  evidence?: CodeEvidence
}

export interface WarEntryInfo {
  path: string
  bytes: number
  kind: 'class' | 'jar' | 'config' | 'resource'
}

export interface WarInventory {
  entries: number
  bytes: number
  class_files: number
  jars: number
  config_files: string[]
  files: WarEntryInfo[]
}

export interface JavaAnalysis {
  schema_version: typeof JAVA_ANALYSIS_SCHEMA_VERSION
  analysis_id: string
  mode: 'source' | 'war'
  input: string
  generated_at: string
  structure: JavaProjectStructure
  classes: JavaClassInfo[]
  endpoints: JavaEndpoint[]
  branches: JavaBranch[]
  exceptions: JavaException[]
  calls: JavaCall[]
  uncertainties: JavaUncertainty[]
  archive?: WarInventory
  coverage: {
    measured: false
    note: string
  }
}

export interface JavaAnalysisSummary {
  analysis_id: string
  mode: 'source' | 'war'
  input: string
  generated_at: string
  classes: number
  endpoints: number
  branches: number
  uncertainties: number
  coverage_measured: false
  path: string
}

export interface JavaAnalysisLimits {
  maxSourceFiles?: number
  maxSourceBytes?: number
  maxArchiveEntries?: number
  maxArchiveBytes?: number
  maxClasses?: number
}
