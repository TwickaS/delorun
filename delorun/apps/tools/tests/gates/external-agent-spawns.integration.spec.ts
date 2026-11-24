import { describe, expect, it } from 'vitest'
import { externalAgentSpawnErrors, sourceViolations } from '../../src/checks/gates/external-agent-spawns.ts'
import { gatePath, runTsx, scratchRepo } from './support.ts'

/**
 * @param path - a repository-relative path.
 * @param lines - the source lines.
 * @returns each violation as `line:column rule found`.
 */
const violations = (path: string, lines: readonly string[]): string[] =>
  sourceViolations(path, lines.join('\n')).map(found => `${found.position} ${found.rule} ${found.found}`)

describe('gates:external-agent-spawns', () => {
  it('refuses a value use of the Agent SDK or its platform packages outside the Claude driver\'s loader', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'import { query } from \'@anthropic-ai/claude-agent-sdk\'',
      'const sdk = await import(\'@anthropic-ai/claude-agent-sdk/bridge\')',
      'const native = `@anthropic-ai/claude-agent-sdk-${process.platform}`',
      'import type { Options } from \'@anthropic-ai/claude-agent-sdk\'',
      'type T = import(\'@anthropic-ai/claude-agent-sdk\').Query',
    ])).toEqual([
      '1:23 sdk @anthropic-ai/claude-agent-sdk',
      '2:26 sdk @anthropic-ai/claude-agent-sdk/bridge',
      '3:16 sdk @anthropic-ai/claude-agent-sdk-',
    ])
    expect(violations('delorun/packages/agent-claude-code/src/sdk.ts', ['const sdk = await import(\'@anthropic-ai/claude-agent-sdk\')'])).toEqual([])
    expect(violations('delorun/packages/agent-claude-code/src/driver.ts', ['const sdk = await import(\'@anthropic-ai/claude-agent-sdk\')'])).toEqual(['1:26 sdk @anthropic-ai/claude-agent-sdk'])
  })

  it('refuses naming the Codex package outside the Codex driver and the login command', () => {
    expect(violations('delorun/packages/plugin-onboarding/src/a.ts', ['const bin = require.resolve(\'@openai/codex/bin/codex.js\')'])).toEqual(['1:29 codex @openai/codex/bin/codex.js'])
    expect(violations('delorun/packages/agent-codex/src/driver.ts', ['const bin = \'@openai/codex\''])).toEqual([])
    expect(violations('delorun/apps/cli/src/agents/resolve.ts', ['const bin = \'@openai/codex/package.json\''])).toEqual([])
  })

  it('refuses the locators outside the files that may start or sign in a program', () => {
    expect(violations('delorun/packages/agent-seats/src/a.ts', [
      'import { locateCodex, loginProgramFor } from \'@delorun/external-agents/locate\'',
      'locateClaudeSdk(dir)',
    ])).toEqual(['1:10 locate locateCodex', '1:23 locate loginProgramFor', '2:1 locate locateClaudeSdk'])
    expect(violations('delorun/packages/agent-codex/src/driver.ts', ['import { locateCodex } from \'@delorun/external-agents/locate\''])).toEqual([])
    expect(violations('delorun/apps/cli/src/agents/command.ts', ['loginProgramFor(agent, dir, machine)'])).toEqual([])
  })

  it('refuses child_process and the subprocess service in the gate\'s package and the drivers, except where allowed', () => {
    expect(violations('delorun/packages/agent-codex/src/driver.ts', [
      'import { spawn } from \'node:child_process\'',
      'const handle = ctx.subprocess.spawn(spec)',
      'const service = ctx.get(\'subprocess\')',
    ])).toEqual(['1:23 child-process node:child_process', '2:20 subprocess subprocess', '3:25 subprocess subprocess'])
    expect(violations('delorun/packages/external-agents/src/accounts/probe.ts', ['const cp = require(\'child_process\')'])).toEqual(['1:20 child-process child_process'])
    expect(violations('delorun/packages/agent-claude-code/src/watcher.mjs', ['import { spawn } from \'node:child_process\''])).toEqual([])
    expect(violations('delorun/packages/external-agents/src/gate.ts', ['this.ctx.subprocess.spawn(spec)'])).toEqual([])
    expect(violations('delorun/packages/home/src/a.ts', ['import { spawn } from \'node:child_process\'', 'ctx.subprocess.spawn(spec)'])).toEqual([])
  })

  it('refuses claude and codex as the program a process runs, by name or path, outside the login command', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'spawn(\'claude\', [\'-p\', prompt])',
      'execFileSync(\'/usr/local/bin/codex\', [\'exec\'])',
      'fork(`${bin}/claude.exe`)',
      'execSync(\'codex login\')',
      'ctx.subprocess.spawn({ argv: [\'C:\\\\tools\\\\codex.exe\', \'exec\'], cwd })',
      'spawnSync(\'node\', [\'claude-helper.js\'])',
      'spawn(\'git\', [\'log\', \'--grep\', \'claude code\'])',
    ])).toEqual([
      '1:7 program claude',
      '2:14 program /usr/local/bin/codex',
      '3:6 program /claude.exe',
      '4:10 program codex',
      '5:31 program C:\\tools\\codex.exe',
    ])
    expect(violations('delorun/apps/cli/src/agents/login.ts', ['spawn(\'claude\', [\'login\'])'])).toEqual([])
  })

  it('refuses the Claude Code package, any argv element naming a program, and the first word of a shell or env command', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'spawn(\'npx\', [\'@anthropic-ai/claude-code\'])',
      'spawn(\'sh\', [\'-c\', \'claude -p "fix it"\'])',
      'spawn(\'env\', [\'claude\'])',
      'ctx.subprocess.spawn({ argv: [\'bash\', \'-lc\', \'FOO=1 exec codex exec\'] })',
      'execFile(\'npx\', [\'@openai/codex\', \'exec\'])',
      'spawn(\'sh\', [\'-c\', \'echo claude\'])',
      'spawn(\'git\', [\'commit\', \'-m\', \'claude fixed it\'])',
    ])).toEqual([
      '1:15 sdk @anthropic-ai/claude-code',
      '2:20 program claude',
      '3:15 program claude',
      '4:46 program codex',
      '5:18 codex @openai/codex',
    ])
  })

  it('refuses a program named in any part of a shell command line, and in a command line given to a shell option', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'spawn(\'claude -p hi\', { shell: true })',
      'spawn(\'bash\', [\'-c\', \'cd w && claude -p\'])',
      'spawn(\'sh\', [\'-c\', \'true; codex\'])',
      'exec(\'ls | FOO=1 nohup codex exec\')',
      'execSync(\'make\\n/usr/local/bin/claude --version\')',
      'execFile(\'codex exec\', { shell })',
      'ctx.subprocess.spawn({ argv: [\'sh\', \'-lc\', \'git pull || exec env claude\'] })',
    ])).toEqual([
      '1:7 program claude',
      '2:22 program claude',
      '3:20 program codex',
      '4:6 program codex',
      '5:10 program /usr/local/bin/claude',
      '6:10 program codex',
      '7:44 program claude',
    ])
  })

  it('refuses a program behind the options of env, which take a value or stand alone', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'exec(\'env -i claude\')',
      'exec(\'env -u FOO claude\')',
      'exec(\'env --unset=FOO codex exec\')',
      'exec(\'env -C /tmp claude\')',
      'exec(\'env -- claude\')',
      'exec(\'nohup env -i FOO=1 claude\')',
      'exec(\'env -i make\')',
      'exec(\'env -u FOO git status\')',
    ])).toEqual([
      '1:6 program claude',
      '2:6 program claude',
      '3:6 program codex',
      '4:6 program claude',
      '5:6 program claude',
      '6:6 program claude',
    ])
  })

  it('allows shell command lines whose command words are not the programs', () => {
    expect(violations('delorun/packages/home/src/a.ts', [
      'spawn(\'git log --grep claude\', { shell: true })',
      'spawn(\'sh\', [\'-c\', \'echo codex && ls | grep claude; true\'])',
      'spawn(\'git commit -m "claude fixed it"\')',
      'spawn(\'claude-helper --run\', { shell: false })',
      'exec(\'cd claude && make\')',
    ])).toEqual([])
  })

  it('allows only presence checks of the two providers', () => {
    expect(violations('delorun/packages/agent-claude-code/src/index.ts', [
      'if (ctx.subagents.getProvider(\'claude-code\') !== undefined) mount()',
      'if (undefined === subagents.getProvider(\'codex\')) return',
      'if (subagents.getProvider(\'codex\')! != null) return',
      'const provider = subagents.getProvider(\'claude-code\')',
      'await subagents.getProvider(\'codex\')?.start(spec)',
      'subagents.getProvider(name)',
    ])).toEqual(['4:18 provider getProvider(\'claude-code\')', '5:7 provider getProvider(\'codex\')'])
  })

  it('reads only Delorun sources, from the command line, exiting 1 on a violation and 0 on a clean tree', (test) => {
    const bad = scratchRepo(test)
    bad.write({
      'delorun/packages/home/src/a.ts': 'export const sdk = () => import(\'@anthropic-ai/claude-agent-sdk\')\n',
      'delorun/packages/home/tests/a.spec.ts': 'export const sdk = () => import(\'@anthropic-ai/claude-agent-sdk\')\n',
      'packages/core/agent/src/a.ts': 'export const sdk = () => import(\'@anthropic-ai/claude-agent-sdk\')\n',
    })
    expect(externalAgentSpawnErrors(bad.root)).toEqual([
      'delorun/packages/home/src/a.ts:1:33: sdk: @anthropic-ai/claude-agent-sdk outside the files the rule allows; only the start gate of @delorun/external-agents starts Claude Code or Codex',
    ])
    const failed = runTsx(bad.root, gatePath('external-agent-spawns'))
    expect(failed.status).toBe(1)
    expect(failed.output).toContain('delorun/packages/home/src/a.ts:1:33')
    const good = scratchRepo(test)
    good.write({ 'delorun/packages/home/src/a.ts': 'export const a = 1\n' })
    expect(runTsx(good.root, gatePath('external-agent-spawns')).status).toBe(0)
    expect(externalAgentSpawnErrors(scratchRepo(test).root)).toEqual(['delorun/: no Delorun tree at the repository root, so there are no sources to check'])
  }, 60_000)
})
