import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runUiTestCase } from '../ui/runner.ts'
import { importUiRecording, parseUiTestCase, validateUiTestCase } from '../ui/validation.ts'

export async function uiCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? ''
  if (subcommand === 'validate') {
    const path = resolve(requireArg(argv[1] ?? '', 'UI case file'))
    const result = validateUiTestCase(JSON.parse(await readFile(path, 'utf8')) as unknown)
    console.log(JSON.stringify({ valid: result.valid, issues: result.issues }, null, 2))
    if (!result.valid) process.exitCode = 1
    return
  }
  if (subcommand === 'import') {
    const inputPath = resolve(requireArg(argv[1] ?? '', 'recording file'))
    const caseId = requireOption(argv.slice(2), '--case-id')
    const outputPath = resolve(option(argv.slice(2), '--output') ?? join('.test-agent', 'ui-cases', `${caseId}.json`))
    const version = positiveInteger(option(argv.slice(2), '--version') ?? '1')
    const testCase = importUiRecording(JSON.parse(await readFile(inputPath, 'utf8')) as unknown, { caseId, version })
    await mkdir(join(outputPath, '..'), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(testCase, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ case_path: outputPath, case_id: caseId, version, steps: testCase.steps.length }, null, 2))
    return
  }
  if (subcommand === 'run') {
    const path = resolve(requireArg(argv[1] ?? '', 'UI case file'))
    const options = argv.slice(2)
    const outputDirectory = resolve(option(options, '--output-dir') ?? 'output')
    const testCase = parseUiTestCase(await readFile(path, 'utf8'))
    if (options.includes('--headed')) testCase.headless = false
    await mkdir(outputDirectory, { recursive: true })
    const report = await runUiTestCase(testCase, {
      outputDirectory,
      chromeExecutable: option(options, '--chrome'),
    })
    const reportPath = join(outputDirectory, `${report.run_id}.report.json`)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({
      run_id: report.run_id,
      status: report.status,
      steps_total: report.steps_total,
      steps_passed: report.steps_passed,
      steps_failed: report.steps_failed,
      report_path: reportPath,
      screenshots: report.screenshots,
    }, null, 2))
    if (report.status !== 'passed') process.exitCode = 1
    return
  }
  console.log(`test-agent ui commands:
  test-agent ui validate <case.json>
  test-agent ui import <recording.json> --case-id <id> [--version <n>] [--output <case.json>]
  test-agent ui run <case.json> [--output-dir <dir>] [--headed] [--chrome <path>]`)
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

function positiveInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('version must be a positive integer')
  return parsed
}
