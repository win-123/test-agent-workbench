import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { redactSensitiveText } from '../desktop/security.ts'
import { isOriginAllowed, validateUiTestCase } from './validation.ts'
import type {
  UiCase,
  UiConsoleEntry,
  UiLocator,
  UiRunnerOptions,
  UiStep,
  UiStepResult,
  UiTestReport,
} from './types.ts'

export async function runUiTestCase(testCase: UiCase, options: UiRunnerOptions): Promise<UiTestReport> {
  const validation = validateUiTestCase(testCase)
  if (!validation.valid) throw new Error(`UI test case is invalid: ${validation.issues.map(item => item.message).join('; ')}`)
  const runId = options.runId ?? createRunId()
  const startedAt = new Date()
  const started = performance.now()
  const screenshotDirectory = join(options.outputDirectory, 'ui', runId)
  await mkdir(screenshotDirectory, { recursive: true })
  let browser: Browser | undefined
  const consoleEntries: UiConsoleEntry[] = []
  const pageErrors: string[] = []
  const steps: UiStepResult[] = []
  let fatalError: string | undefined
  try {
    browser = await chromium.launch({
      headless: testCase.headless,
      ...options.chromeExecutable === undefined ? { channel: 'chrome' } : { executablePath: options.chromeExecutable },
    })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: false,
    })
    await context.route('**/*', async route => {
      const url = route.request().url()
      if (!url.startsWith('http://') && !url.startsWith('https://')) return await route.abort()
      if (!isOriginAllowed(url, testCase.allowed_origins)) return await route.abort('blockedbyclient')
      await route.continue()
    })
    const page = await context.newPage()
    page.on('console', message => {
      if (consoleEntries.length >= 500) return
      consoleEntries.push({
        type: message.type(),
        text: redactSensitiveText(truncate(message.text())),
        at: new Date().toISOString(),
      })
    })
    page.on('pageerror', error => {
      if (pageErrors.length < 50) pageErrors.push(redactSensitiveText(truncate(error.message)))
    })
    const abort = (): void => {
      void browser?.close()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    for (const step of testCase.steps) {
      if (options.signal?.aborted) break
      const result = await executeStep(page, step, testCase, screenshotDirectory)
      steps.push(result)
      if (result.status === 'failed') break
    }
    options.signal?.removeEventListener('abort', abort)
  } catch (error) {
    fatalError = redactSensitiveText((error as Error).message)
  } finally {
    await browser?.close().catch(() => undefined)
  }
  const finishedAt = new Date()
  const failed = steps.filter(step => step.status === 'failed')
  const cancelled = options.signal?.aborted === true
  const status = cancelled ? 'cancelled' : fatalError !== undefined ? 'engine_error' : failed.length > 0 ? 'failed' : 'passed'
  return {
    run_id: runId,
    case_id: testCase.case_id,
    case_version: testCase.version,
    name: testCase.name,
    status,
    target_url: redactSensitiveText(testCase.target_url),
    browser: browser?.version() ?? 'chrome',
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    steps_total: testCase.steps.length,
    steps_passed: steps.filter(step => step.status === 'passed').length,
    steps_failed: failed.length,
    steps,
    console: consoleEntries,
    page_errors: pageErrors,
    screenshots: steps.flatMap(step => step.screenshot_path === undefined ? [] : [step.screenshot_path]),
    ...fatalError === undefined ? {} : { error: fatalError },
    sensitive_redacted: true,
  }
}

async function executeStep(page: Page, step: UiStep, testCase: UiCase, screenshotDirectory: string): Promise<UiStepResult> {
  const defaultTimeout = testCase.timeout_ms
  const startedAt = new Date()
  const started = performance.now()
  let actual: string | undefined
  try {
    if (step.action === 'navigate') {
      if (!isOriginAllowed(step.url, testCase.allowed_origins)) throw new Error('navigation URL origin is not allowed')
      const response = await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: defaultTimeout })
      if (response === null) throw new Error('navigation produced no response')
      if (!response.ok()) throw new Error(`navigation returned HTTP ${response.status()}`)
      actual = redactSensitiveText(`${response.status()} ${page.url()}`)
    } else if (step.action === 'click') {
      const locator = resolveLocator(page, step.locator)
      await locator.click({ timeout: defaultTimeout })
      actual = `${await locator.count()} matching element(s)`
    } else if (step.action === 'fill') {
      const locator = resolveLocator(page, step.locator)
      await locator.fill(step.value, { timeout: defaultTimeout })
      actual = '[input value redacted]'
    } else if (step.action === 'select') {
      const locator = resolveLocator(page, step.locator)
      await locator.selectOption(step.value, { timeout: defaultTimeout })
      actual = step.value
    } else if (step.action === 'wait') {
      const timeout = step.timeoutMs ?? defaultTimeout
      if (step.locator !== undefined) {
        await resolveLocator(page, step.locator).waitFor({ state: step.state ?? 'visible', timeout })
        actual = step.state ?? 'visible'
      } else {
        await page.waitForTimeout(timeout)
        actual = `waited ${timeout} ms`
      }
    } else {
      actual = await evaluateAssertion(page, step, defaultTimeout)
    }
    return result(step, startedAt, started, 'passed', actual)
  } catch (error) {
    const screenshot = await captureFailure(page, step, screenshotDirectory)
    return result(step, startedAt, started, 'failed', actual, redactSensitiveText((error as Error).message), screenshot)
  }
}

async function evaluateAssertion(page: Page, step: Extract<UiStep, { action: 'assert' }>, timeout: number): Promise<string> {
  if (step.locator === undefined) throw new Error('assertion requires a locator')
  const locator = resolveLocator(page, step.locator)
  const assertionTimeout = step.timeoutMs ?? timeout
  if (step.assertion === 'visible') {
    await locator.waitFor({ state: 'visible', timeout: assertionTimeout })
    return 'visible'
  }
  if (step.assertion === 'hidden') {
    await locator.waitFor({ state: 'hidden', timeout: assertionTimeout })
    return 'hidden'
  }
  if (step.assertion === 'count') {
    const expected = Number(step.expected)
    const deadline = Date.now() + assertionTimeout
    while (Date.now() < deadline) {
      const count = await locator.count()
      if (count === expected) return String(count)
      await page.waitForTimeout(50)
    }
    throw new Error(`locator count mismatch: expected ${expected}, got ${await locator.count()}`)
  }
  if (step.assertion === 'text' || step.assertion === 'containsText') {
    const expected = String(step.expected)
    const deadline = Date.now() + assertionTimeout
    let text = ''
    while (Date.now() < deadline) {
      text = (await locator.textContent()) ?? ''
      if (step.assertion === 'text' ? text === expected : text.includes(expected)) return redactSensitiveText(text)
      await page.waitForTimeout(50)
    }
    throw new Error(`text assertion failed: expected ${step.assertion === 'text' ? 'exactly' : 'to contain'} ${JSON.stringify(expected)}, got ${JSON.stringify(redactSensitiveText(text))}`)
  }
  const expected = String(step.expected)
  const actual = await locator.inputValue()
  if (actual !== expected) throw new Error(`value assertion failed: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  return actual
}

function resolveLocator(page: Page, locator: UiLocator): Locator {
  if (locator.kind === 'role') {
    return page.getByRole(locator.role ?? 'button', { name: locator.name ?? locator.value, exact: locator.exact })
  }
  if (locator.kind === 'label') return page.getByLabel(locator.value, { exact: locator.exact })
  if (locator.kind === 'testId') return page.getByTestId(locator.value)
  if (locator.kind === 'text') return page.getByText(locator.value, { exact: locator.exact })
  return page.locator(locator.value)
}

async function captureFailure(page: Page, step: UiStep, directory: string): Promise<string | undefined> {
  try {
    const path = join(directory, `failure-${safeName(step.id)}.png`)
    await page.screenshot({ path, fullPage: true })
    return path
  } catch {
    return undefined
  }
}

function result(
  step: UiStep,
  startedAt: Date,
  started: number,
  status: 'passed' | 'failed',
  actual?: string,
  error?: string,
  screenshot?: string,
): UiStepResult {
  return {
    id: step.id,
    action: step.action,
    status,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    description: step.description,
    expected: step.action === 'assert' ? String(step.expected ?? '') : undefined,
    actual,
    ...error === undefined ? {} : { error },
    ...screenshot === undefined ? {} : { screenshot_path: screenshot },
  }
}

function createRunId(): string {
  return `ui_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function truncate(value: string): string {
  return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value
}
