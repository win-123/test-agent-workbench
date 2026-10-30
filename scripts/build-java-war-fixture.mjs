import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = join(root, 'fixtures', 'java-war-fixture')
const output = join(fixture, 'demo.war')
const staging = await mkdtemp(join(tmpdir(), 'test-agent-war-fixture-'))
const classes = join(staging, 'classes')
await mkdir(classes, { recursive: true })
const result = spawnSync('javac', ['-g', '-d', classes, join(fixture, 'src', 'com', 'example', 'war', 'DemoService.java')], {
  stdio: 'inherit',
})
if (result.status !== 0) {
  await rm(staging, { recursive: true, force: true })
  throw new Error('javac is required to build the WAR fixture')
}
const zip = new JSZip()
zip.file('WEB-INF/classes/com/example/war/DemoService.class', await readFile(join(classes, 'com', 'example', 'war', 'DemoService.class')))
zip.file('WEB-INF/web.xml', await readFile(join(fixture, 'WEB-INF', 'web.xml')))
zip.file('WEB-INF/lib/empty-dependency.jar', await new JSZip().generateAsync({ type: 'nodebuffer' }))
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }))
await rm(staging, { recursive: true, force: true })
console.log(output)
