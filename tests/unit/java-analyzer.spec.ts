import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { analyzeJavaInput, analyzeJavaSource, analyzeWar } from '../../src/code/java-analyzer.ts'

const run = promisify(execFile)

describe('Java source analysis', () => {
  it('extracts Spring endpoints, methods, branches, exceptions and call evidence', async () => {
    const analysis = await analyzeJavaSource('fixtures/java-project')
    expect(analysis.mode).toBe('source')
    expect(analysis.structure.frameworks).toContain('Spring')
    expect(analysis.structure.build_files).toContain('pom.xml')
    expect(analysis.endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        http_method: 'GET',
        path: '/api/orders/{id}',
        class_name: 'com.example.orders.OrderController',
        method: 'findOrder',
      }),
      expect.objectContaining({
        http_method: 'POST',
        path: '/api/orders',
        method: 'createOrder',
        request_body: true,
      }),
    ]))
    const get = analysis.endpoints.find(endpoint => endpoint.method === 'findOrder')!
    expect(get.evidence.file).toBe('src/main/java/com/example/orders/OrderController.java')
    expect(get.evidence.line).toBeGreaterThan(10)
    const controller = analysis.classes.find(item => item.name.endsWith('OrderController'))!
    expect(controller.methods.map(method => method.name)).toEqual(expect.arrayContaining(['findOrder', 'createOrder']))
    expect(analysis.branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'findOrder', kind: 'if' }),
      expect.objectContaining({ method: 'submit', kind: 'case' }),
    ]))
    expect(analysis.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'findOrder', kind: 'throw', type: 'IllegalArgumentException' }),
      expect.objectContaining({ method: 'createOrder', kind: 'catch', type: 'RuntimeException' }),
    ]))
    expect(analysis.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'service.find', arguments: ['id'], parameter_evidence: 'source-text' }),
      expect.objectContaining({ target: 'service.submit', resolved: true }),
    ]))
    expect(analysis.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'reflection' }),
    ]))
    expect(analysis.coverage.measured).toBe(false)
  })

  it('rejects an input type that cannot be analyzed', async () => {
    await expect(analyzeJavaInput('package.json')).rejects.toThrow('supports a source directory')
  })
})

describe('WAR bytecode analysis', () => {
  it('inventories a WAR and rebuilds class/method/call metadata without claiming endpoints', async () => {
    const available = await hasJavac()
    if (!available) return
    const directory = await mkdtemp(join(tmpdir(), 'test-agent-war-'))
    const source = join(directory, 'DemoService.java')
    const classes = join(directory, 'classes')
    await mkdir(classes, { recursive: true })
    await writeFile(source, `
public class DemoService {
  public String choose(boolean enabled, String value) {
    try {
      if (enabled) {
        return helper(value);
      }
      throw new IllegalArgumentException("disabled");
    } catch (RuntimeException error) {
      throw new IllegalStateException("wrapped", error);
    }
  }
  private String helper(String value) { return value.trim(); }
}
`)
    await run('javac', ['-g', '-d', classes, source])
    const classBytes = await readFile(join(classes, 'DemoService.class'))
    const zip = new JSZip()
    zip.file('WEB-INF/classes/DemoService.class', classBytes)
    zip.file('WEB-INF/web.xml', '<web-app />')
    zip.file('WEB-INF/lib/dependency.jar', await new JSZip().generateAsync({ type: 'nodebuffer' }))
    const warPath = join(directory, 'demo.war')
    await writeFile(warPath, await zip.generateAsync({ type: 'nodebuffer' }))

    const analysis = await analyzeWar(warPath)
    if (analysis.classes.length === 0) console.error(JSON.stringify(analysis.uncertainties, null, 2))
    expect(analysis.mode).toBe('war')
    expect(analysis.archive).toMatchObject({ class_files: 1, jars: 1 })
    expect(analysis.archive?.config_files).toContain('WEB-INF/web.xml')
    expect(analysis.classes[0]).toMatchObject({
      name: 'DemoService',
      file: 'WEB-INF/classes/DemoService.class',
      confidence: 'bytecode',
    })
    expect(analysis.classes[0]?.methods.map(method => method.name)).toEqual(expect.arrayContaining(['choose', 'helper']))
    expect(analysis.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'DemoService.helper', parameter_types: ['java.lang.String'], parameter_evidence: 'bytecode-descriptor' }),
    ]))
    expect(analysis.branches.length).toBeGreaterThan(0)
    expect(analysis.exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'catch' }),
    ]))
    expect(analysis.endpoints).toEqual([])
    expect(analysis.uncertainties).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing-dependency' }),
    ]))
    expect(analysis.coverage.measured).toBe(false)
  })
})

async function hasJavac(): Promise<boolean> {
  try {
    await run('javac', ['-version'])
    return true
  } catch {
    return false
  }
}
