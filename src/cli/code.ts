import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { analyzeJavaInput } from '../code/java-analyzer.ts'

export async function codeCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0] ?? ''
  if (subcommand === 'analyze' || subcommand === 'source' || subcommand === 'war') {
    const input = resolve(requireArg(argv[1] ?? '', 'Java source directory, WAR, or class file'))
    const options = argv.slice(2)
    const analysis = await analyzeJavaInput(input)
    const output = resolve(option(options, '--output') ?? join('.test-agent', 'code-analysis', `${analysis.analysis_id}.json`))
    await mkdir(join(output, '..'), { recursive: true })
    await writeFile(output, `${JSON.stringify(analysis, null, 2)}\n`, { mode: 0o600 })
    const summary = {
      analysis_id: analysis.analysis_id,
      mode: analysis.mode,
      output,
      source_files: analysis.structure.source_files,
      classes: analysis.classes.length,
      endpoints: analysis.endpoints.length,
      branches: analysis.branches.length,
      exceptions: analysis.exceptions.length,
      uncertainties: analysis.uncertainties.length,
      coverage_measured: analysis.coverage.measured,
    }
    console.log(JSON.stringify(options.includes('--json') ? analysis : summary, null, 2))
    return
  }
  console.log(`test-agent code commands:
  test-agent code analyze <source-dir|file.war|file.class> [--output <json>] [--json]
  test-agent code source <source-dir> [--output <json>]
  test-agent code war <file.war> [--output <json>]`)
}

function requireArg(value: string, name: string): string {
  if (value.length === 0) throw new Error(`missing required ${name}`)
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
