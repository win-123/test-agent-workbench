import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AssetService } from '../assets/service.ts'
import { CoverageService } from '../coverage/service.ts'
import { ProjectService } from '../desktop/project-service.ts'
import { ProjectRunGate, TaskService } from '../desktop/task-service.ts'
import type { JavaAnalysis } from '../code/types.ts'
import { UiCaseService } from '../ui/service.ts'

export async function assetCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? ''
  if (!['scan', 'list', 'run', 'history', 'compare'].includes(subcommand)) {
    console.log(`test-agent asset commands:
  test-agent asset scan --project <dir>
  test-agent asset list --project <dir>
  test-agent asset run <asset-id> --project <dir>
  test-agent asset history <asset-id> --project <dir>
  test-agent asset compare <asset-id> --project <dir> [--left <run>] [--right <run>]`)
    return
  }
  const runtime = await openProject(requireOption(argv.slice(1), '--project'))
  if (subcommand === 'scan') console.log(JSON.stringify(await runtime.assets.scanExisting(), null, 2))
  else if (subcommand === 'list') console.log(JSON.stringify(await runtime.assets.list(), null, 2))
  else {
    const assetId = requireArg(argv[1] ?? '', 'asset id')
    if (subcommand === 'run') {
      const snapshot = await runtime.assets.executeAndWait(assetId)
      console.log(JSON.stringify(snapshot, null, 2))
      if (!['passed', 'succeeded'].includes(snapshot.task.status)) process.exitCode = 1
    } else if (subcommand === 'history') {
      console.log(JSON.stringify(await runtime.assets.history(assetId), null, 2))
    } else {
      console.log(JSON.stringify(await runtime.assets.compare(
        assetId,
        option(argv.slice(2), '--left'),
        option(argv.slice(2), '--right'),
      ), null, 2))
    }
  }
}

export async function coverageCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? ''
  if (!['analyze', 'execute', 'list'].includes(subcommand)) {
    console.log(`test-agent coverage commands:
  test-agent coverage analyze <java-analysis.json> --project <dir> [--runtime <coverage.json>]
  test-agent coverage execute <analysis-id> <candidate-id> --project <dir>
  test-agent coverage list --project <dir>`)
    return
  }
  const runtime = await openProject(requireOption(argv.slice(1), '--project'))
  if (subcommand === 'list') {
    console.log(JSON.stringify(await runtime.coverage.list(), null, 2))
    return
  }
  if (subcommand === 'analyze') {
    const analysisPath = resolve(requireArg(argv[1] ?? '', 'Java analysis file'))
    const java = JSON.parse(await readFile(analysisPath, 'utf8')) as JavaAnalysis
    const analysis = await runtime.coverage.analyze(java, option(argv.slice(2), '--runtime'))
    const saved = await runtime.coverage.save(analysis)
    console.log(JSON.stringify({ ...analysis, path: saved }, null, 2))
    return
  }
  const analysisId = requireArg(argv[1] ?? '', 'coverage analysis id')
  const candidateId = requireArg(argv[2] ?? '', 'candidate id')
  console.log(JSON.stringify(await runtime.coverage.executePersistedCandidate(analysisId, candidateId), null, 2))
}

async function openProject(projectPath: string) {
  const root = resolve(projectPath)
  const projects = new ProjectService({ appDataDirectory: join(root, '.test-agent', 'cli-app-data') })
  await projects.initialize()
  await projects.open(root)
  const gate = new ProjectRunGate()
  const tasks = new TaskService({ projects, gate })
  const ui = new UiCaseService({ projects, tasks, gate })
  const assets = new AssetService({ projects, tasks, uiCases: ui })
  const coverage = new CoverageService({ projects, tasks, assets })
  await assets.scanExisting()
  return { projects, tasks, ui, assets, coverage }
}

function requireArg(value: string, name: string): string {
  if (value.length === 0) throw new Error(`missing required ${name}`)
  return value
}

function requireOption(argv: string[], name: string): string {
  const value = option(argv, name)
  if (value === undefined || value.length === 0) throw new Error(`missing required option ${name}`)
  return value
}

function option(argv: string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === name) {
      const next = argv[index + 1]
      return next !== undefined && !next.startsWith('-') ? next : undefined
    }
    if (value?.startsWith(`${name}=`) === true) return value.slice(name.length + 1)
  }
  return undefined
}
