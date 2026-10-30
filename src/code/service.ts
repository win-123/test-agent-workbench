import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeTaskId, resolveInside } from '../desktop/security.ts'
import type { ProjectService } from '../desktop/project-service.ts'
import { analyzeJavaInput } from './java-analyzer.ts'
import {
  JAVA_ANALYSIS_SCHEMA_VERSION,
  type JavaAnalysis,
  type JavaAnalysisSummary,
} from './types.ts'

export interface CodeAnalysisServiceOptions {
  projects: ProjectService
}

export class CodeAnalysisService {
  private readonly projects: ProjectService

  constructor(options: CodeAnalysisServiceOptions) {
    this.projects = options.projects
  }

  async analyze(inputPath: string): Promise<{ analysis: JavaAnalysis; path: string }> {
    const analysis = await analyzeJavaInput(inputPath)
    const root = this.requireRoot()
    const path = resolveInside(root, join('.test-agent', 'code-analysis', `${analysis.analysis_id}.json`))
    await mkdir(join(path, '..'), { recursive: true })
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return { analysis, path }
  }

  async get(analysisId: string): Promise<JavaAnalysis> {
    assertSafeTaskId(analysisId)
    const root = this.requireRoot()
    const path = resolveInside(root, join('.test-agent', 'code-analysis', `${analysisId}.json`))
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('code analysis must be an object')
    const record = parsed as Partial<JavaAnalysis>
    if (record.schema_version !== JAVA_ANALYSIS_SCHEMA_VERSION || record.analysis_id !== analysisId) throw new Error('invalid code analysis record')
    return record as JavaAnalysis
  }

  async list(): Promise<JavaAnalysisSummary[]> {
    const root = this.requireRoot()
    const directory = resolveInside(root, join('.test-agent', 'code-analysis'))
    const entries = await readdir(directory).catch(() => [])
    const summaries: JavaAnalysisSummary[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const analysisId = entry.slice(0, -5)
      try {
        const analysis = await this.get(analysisId)
        summaries.push({
          analysis_id: analysis.analysis_id,
          mode: analysis.mode,
          input: analysis.input,
          generated_at: analysis.generated_at,
          classes: analysis.classes.length,
          endpoints: analysis.endpoints.length,
          branches: analysis.branches.length,
          uncertainties: analysis.uncertainties.length,
          coverage_measured: false,
          path: join('.test-agent', 'code-analysis', entry),
        })
      } catch {
        // Ignore incomplete analysis files.
      }
    }
    return summaries.sort((left, right) => right.generated_at.localeCompare(left.generated_at))
  }

  private requireRoot(): string {
    if (this.projects.root === undefined) throw new Error('no project is open')
    return this.projects.root
  }
}
