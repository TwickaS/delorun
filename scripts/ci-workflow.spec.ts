import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { gatesForMode } from './run-gates.ts'
import { upstreamRunsOn } from './tests/delorun-repository-guard.ts'

function evaluateRunsOn(selector: unknown, context: Record<string, unknown>): unknown {
  if (typeof selector !== 'string') throw new TypeError('Runner selector must be a string')
  return runInNewContext(selector.trim().slice(3, -2), { fromJSON: JSON.parse, ...context }, { timeout: 1000 })
}

const root = resolve(import.meta.dirname, '..')
const runnerPrivatePnpmDestination = /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/
const laneJobs = ['node-24', 'node-24-lint'] as const

describe('CI workflow', () => {
  it('keeps the static analysis and lint jobs and the aggregate verdict as the only jobs', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(ci.jobs)) throw new TypeError('ci.yml must define jobs')
    expect(Object.keys(ci.jobs).sort()).toEqual(['all-checks-passed', 'node-24', 'node-24-lint'])
    for (const [name, job] of Object.entries(ci.jobs)) {
      if (!isRecord(job)) throw new TypeError(`${name} must define a job`)
      expect(job).not.toHaveProperty('strategy')
      expect(job).not.toHaveProperty('uses')
    }
  })

  it('reports one required verdict that waits for every other job and runs only on pull requests', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    const verdict = workflowJob(ci, 'all-checks-passed')
    expect(ci.on).toEqual({ pull_request: null })
    expect(verdict.name).toBe('all checks passed')
    expect(verdict.needs).toEqual([...laneJobs])
    expect(verdict.if).toBe("${{ !cancelled() && github.event_name == 'pull_request' }}")
    for (const name of laneJobs) expect(workflowJob(ci, name).if).toBe("github.event_name == 'pull_request'")
  })

  it('cancels a superseded validation run without crossing workflow or ref boundaries', () => {
    expect(loadWorkflow('.github/workflows/ci.yml').concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
  })

  it.each(laneJobs)('%s runs on hosted Linux outside upstream\'s repository and on upstream\'s pool inside it', (name) => {
    const selector = workflowJob(loadWorkflow('.github/workflows/ci.yml'), name)['runs-on']
    const pullRequest = { user: { login: 'someone' } }
    expect(evaluateRunsOn(selector, { github: { repository: 'TwickaS/delorun', event: { pull_request: pullRequest } }, vars: {} }))
      .toBe('ubuntu-latest')
    expect(evaluateRunsOn(upstreamRunsOn(String(selector), 'ubuntu-latest'), { github: { event: { pull_request: pullRequest } }, vars: {} }))
      .toBe('dsh-ubuntu-24-04-16core')
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const setups: Array<{ jobName: string; step: unknown }> = []
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(workflow.jobs)) throw new TypeError('ci.yml must define jobs')
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (!isRecord(job) || !Array.isArray(job.steps)) continue
      for (const step of job.steps) {
        if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
        setups.push({ jobName, step })
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
      expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
    }
  })

  it.each(laneJobs)('%s keeps tool and fixture temporary files under runner cleanup', (jobName) => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobName)
    if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} must define steps`)
    expect(job.steps[0]).toEqual({
      name: 'Use runner-owned temporary storage',
      run: 'echo "TMPDIR=${{ runner.temp }}" >> "$GITHUB_ENV"\n',
    })
    const store: unknown = job.steps.find(step => isRecord(step) && step.name === 'Configure pnpm store path')
    expect(store).toMatchObject({
      run: [
        'store_root="$HOME/.local/share/pnpm/store"',
        'echo "PNPM_CONFIG_STORE_DIR=$store_root" >> "$GITHUB_ENV"',
        'store_path=$(PNPM_CONFIG_STORE_DIR="$store_root" pnpm store path --silent)',
        'echo "path=$store_path" >> "$GITHUB_OUTPUT"',
        '',
      ].join('\n'),
    })
    for (const step of job.steps) {
      if (isRecord(step) && isRecord(step.env)) {
        expect(step.env.TMPDIR).toBeUndefined()
        expect(step.env.npm_config_cache).toBeUndefined()
      }
    }
  })

  it.each(laneJobs)('%s redirects the Node compile cache to the runner temp before the first pnpm call', (jobKey) => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), jobKey)
    if (!Array.isArray(job.steps)) throw new TypeError(`${jobKey} must define steps`)
    const redirectStepIndex = job.steps.findIndex((step): step is Record<string, unknown> & { run: string } => (
      isRecord(step) && typeof step.run === 'string'
        && step.run.includes('NODE_COMPILE_CACHE=${{ runner.temp }}/node-compile-cache')
        && step.run.includes('"$GITHUB_ENV"')
    ))
    expect(redirectStepIndex, `${jobKey} must inject NODE_COMPILE_CACHE into GITHUB_ENV`).toBeGreaterThan(-1)
    const pnpmSetupIndex = job.steps.findIndex((step): step is Record<string, unknown> & { uses: string } => (
      isRecord(step) && typeof step.uses === 'string' && step.uses.includes('pnpm/action-setup')
    ))
    expect(pnpmSetupIndex, `${jobKey} must run pnpm/action-setup`).toBeGreaterThan(-1)
    expect(redirectStepIndex, `${jobKey} must redirect before pnpm/action-setup runs pnpm`).toBeLessThan(pnpmSetupIndex)
  })

  it('runs the expected-filenames check on hosted Linux unless Blacksmith is selected', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/expected-filenames.yml'), 'expected-filenames')
    expect(job['runs-on']).toContain('DSH_CI_FAILOVER_LINUX')
    expect(job['runs-on']).toContain("== 'blacksmith'")
    expect(job['runs-on']).toContain('blacksmith-4vcpu-ubuntu-2404')
    expect(job['runs-on']).toContain("'ubuntu-latest'")
  })

  it('keeps the host build and typecheck scripts in the shape the gates rely on', () => {
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const hostSteps = scripts.scripts['build:lib:host']!.split(' && ')
    expect(hostSteps[0]).toBe('tsx scripts/compile-referenced-projects.ts host-libraries')
    expect(hostSteps).toContain('node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc -p tsconfig.host.json')
    expect(hostSteps.at(-1)).toBe('pnpm --filter @deepseek-ai/dsh-desktop run bundle')
    expect(scripts.scripts['build:lib:client']).toContain('tsc -b tsconfig.client.json')
    expect(scripts.scripts.typecheck).toBe('tsx scripts/build.ts --scope typecheck')
  })

  it('splits both Wine TypeScript faces and retains their aggregate heap budgets', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    const references = wineGates.indexOf(
      'wine_node "$scratch/logs/host-references.log" --import tsx/esm scripts/compile-referenced-projects.ts host',
    )
    const aggregate = wineGates.indexOf(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.host.json --pretty false',
    )
    const metadata = wineGates.indexOf('wine_node "$scratch/logs/host-typert.log" --import tsx/esm scripts/generate-typert.ts')
    expect(metadata).toBeGreaterThan(-1)
    expect(references).toBeGreaterThan(metadata)
    expect(aggregate).toBeGreaterThan(references)
    expect(wineGates).not.toContain('-b tsconfig.host.json')
    const clientReferences = wineGates.indexOf('wine_node "$scratch/logs/client-references.log" --import tsx/esm scripts/compile-referenced-projects.ts client')
    const clientAggregate = wineGates.indexOf('wine_node "$scratch/logs/client-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.client.json --pretty false')
    expect(clientReferences).toBeGreaterThan(aggregate)
    expect(clientAggregate).toBeGreaterThan(clientReferences)
    expect(wineGates).not.toContain('-b tsconfig.client.json')
    expect(wineGates).toContain('  "$scratch/logs/client-references.log" \\')
  })

  it('keeps Wine out of the Linux and Windows gate graphs', () => {
    // Graph construction needs a pnpm entrypoint but never launches it.
    const previous = process.env.npm_execpath
    process.env.npm_execpath = '/test/pnpm.cjs'
    try {
      for (const mode of ['ci-linux-primary', 'ci-windows-complete'] as const) {
        expect(gatesForMode(mode).map(gate => gate.displayCommand).join('\n')).not.toMatch(/wine/i)
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
      else process.env.npm_execpath = previous
    }
    expect(process.env.npm_execpath).toBe(previous)
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })

  it('applies the lane test budget inside every Vitest project', () => {
    // Each inline project spreads coverageTestTimeoutOptions, the only route
    // for DSH_COVERAGE_TEST_TIMEOUT_MS into projects; the behavior itself is
    // pinned by scripts/lane-test-budget.spec.ts.
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).toContain('const laneTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV])')
    expect(config.match(/^ {10}\.\.\.laneTestBudget,$/gm)).toHaveLength(2)
  })
})

describe('bubblewrap preparation script', () => {
  it('pins bubblewrap to a recorded Launchpad build and excludes Ubuntu pool downloads', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]

    expect(url).toMatch(
      /^https:\/\/launchpad\.net\/ubuntu\/\+source\/bubblewrap\/[^/]+\/\+build\/\d+\/\+files\/bubblewrap_[^/]+_amd64\.deb$/u,
    )
    // Ubuntu removes superseded versions from its live package pool.
    expect(script).not.toMatch(/https?:\/\/[^/'"\s]+\/ubuntu(?:-ports)?\/pool\//u)
  })

  it('verifies the archive against the pinned digest', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')

    expect(script).toMatch(/^readonly BUBBLEWRAP_SHA256='[0-9a-f]{64}'$/mu)
    expect(script).toContain('acquire_verified_archive "$BUBBLEWRAP_URL" "$BUBBLEWRAP_SHA256" "$archive"')
  })
})

describe('GitLab runtime wheels', () => {
  it('uses the shared macOS deployment-target check in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const runtimeWheel = workflow['.runtime-wheel']
    if (!isRecord(runtimeWheel) || !Array.isArray(runtimeWheel.script)) {
      throw new TypeError('GitLab CI must define the runtime wheel script')
    }
    const runtimeScript: unknown[] = runtimeWheel.script
    const macosCheck = runtimeScript.find(
      step => typeof step === 'string' && step.includes('${PLATFORM#macos-}'),
    )
    if (typeof macosCheck !== 'string') {
      throw new TypeError('GitLab CI must check the macOS deployment target')
    }

    expect(macosCheck).toContain('scripts/check-macos-deployment-target.py')
    expect(macosCheck).toContain('lipo "$payload" -verify_arch')
    expect(macosCheck).toContain('"$EXE" "$EXE-rg" "$EXE-spawn-helper"')
  })

  it('builds the macOS x64 wheel on the matching GitLab runner', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const macosX64 = workflow['runtime-macos-x64']
    const publish = workflow['publish-python']
    if (!isRecord(macosX64) || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the macOS x64 runtime and publication jobs')
    }

    expect(macosX64.tags).toEqual(['macos-x64'])
    expect(macosX64.variables).toMatchObject({ PKG_TARGET: 'node24-macos-x64', PLATFORM: 'macos-x64' })
    expect(publish.needs).toContainEqual({ job: 'runtime-macos-x64', artifacts: true })
    expect(JSON.stringify(publish.script)).toContain('macosx_14_0_x86_64.whl')
  })

  it('builds and black-box tests the Windows x64 wheel in GitLab', () => {
    const workflow = loadWorkflow('.gitlab-ci.yml')
    const windows = workflow['runtime-windows-x64']
    const publish = workflow['publish-python']
    if (!isRecord(windows) || !Array.isArray(windows.before_script) || !Array.isArray(windows.script)
      || !isRecord(publish) || !Array.isArray(publish.needs)) {
      throw new TypeError('GitLab CI must define the Windows runtime and aggregate publication jobs')
    }

    expect(windows.tags).toEqual(['windows-x64'])
    expect(windows.variables).toMatchObject({ PKG_TARGET: 'node24-win-x64', PLATFORM: 'win-x64' })
    expect(JSON.stringify(windows.before_script)).toContain('.ci-python\\\\Scripts')
    expect(JSON.stringify(windows.before_script)).toContain('[IO.Path]::PathSeparator')
    expect(JSON.stringify(windows.script)).toContain('win_amd64.whl')
    expect(JSON.stringify(windows.script)).toContain('--scenario all --installed-wheel')
    expect(publish.needs).toContainEqual({ job: 'runtime-windows-x64', artifacts: true })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')

    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = lefthook[hookName]
      if (!isRecord(hook) || !Array.isArray(hook.jobs)) {
        throw new TypeError(`lefthook must define ${hookName} jobs`)
      }
      const pairing: unknown = hook.jobs.find(
        (job: unknown) => isRecord(job) && job.name === 'translation pairing (staged records)',
      )

      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}


function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
