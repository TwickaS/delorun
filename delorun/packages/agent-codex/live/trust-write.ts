/**
 * Which `thread/start` settings make Codex write a project trust entry into its home's `config.toml`. Runs the pinned
 * program keyless in scratch Codex homes only (never the person's), one variant per home, and prints the lines each
 * variant added.
 *
 *   node_modules/.bin/tsx delorun/packages/agent-codex/live/trust-write.ts
 * @module @delorun/agent-codex/live/trust-write
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { appServerArgv } from '../src/driver.ts'
import { CodexRpc } from '../src/rpc.ts'
import { pinnedCodex } from './common.ts'

/** A variant: `thread/start` settings, and `turn/start` settings for one turn when present. */
interface Variant { readonly thread: Readonly<Record<string, unknown>>; readonly turn?: Readonly<Record<string, unknown>> }

const WORKSPACE_WRITE = (workspace: string) => ({ type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false })

const VARIANTS: Readonly<Record<string, (workspace: string) => Variant>> = {
  'no policy': () => ({ thread: {} }),
  'approvalPolicy untrusted': () => ({ thread: { approvalPolicy: 'untrusted' } }),
  'sandbox workspace-write': () => ({ thread: { sandbox: 'workspace-write' } }),
  'sandbox read-only': () => ({ thread: { sandbox: 'read-only' } }),
  'untrusted + workspace-write': () => ({ thread: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } }),
  'untrusted, turn sandboxPolicy workspaceWrite': workspace => ({ thread: { approvalPolicy: 'untrusted' }, turn: { sandboxPolicy: WORKSPACE_WRITE(workspace) } }),
  'untrusted + read-only, turn sandboxPolicy workspaceWrite': workspace => ({ thread: { approvalPolicy: 'untrusted', sandbox: 'read-only' }, turn: { sandboxPolicy: WORKSPACE_WRITE(workspace) } }),
  'untrusted + sandbox_mode workspace-write in thread config': () => ({ thread: { approvalPolicy: 'untrusted', config: { sandbox_mode: 'workspace-write' } } }),
}

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
for (const [name, variant] of Object.entries(VARIANTS)) {
  const root = mkdtempSync(join(tmpdir(), 'ea1-codex-trust-'))
  try {
    const home = join(root, 'home')
    const workspace = join(root, 'workspace')
    mkdirSync(home)
    mkdirSync(workspace)
    const config = 'model = "fixture-model"\nmodel_provider = "fixture"\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:9/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\n'
    writeFileSync(join(home, 'config.toml'), config)
    const handle = ctx.subprocess.spawn({
      argv: appServerArgv(pinnedCodex()), cwd: workspace, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' }, graceMs: 2_000,
      env: { CODEX_HOME: home, HOME: root, OPENAI_API_KEY: 'fake', HTTPS_PROXY: '', HTTP_PROXY: '' },
    })
    if (handle.stdout === undefined || handle.stdin === undefined) throw new Error('no pipes')
    const rpc = new CodexRpc(handle.stdout, handle.stdin)
    rpc.start({ notification: () => {}, request: () => Promise.resolve(null), violation: () => {} })
    const signal = AbortSignal.timeout(30_000)
    await rpc.request('initialize', { clientInfo: { name: 'delorun', title: 'Delorun', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }, signal)
    rpc.notify('initialized')
    const { thread, turn } = variant(workspace)
    const opened = await rpc.request('thread/start', { cwd: workspace, model: 'fixture-model', ephemeral: false, ...thread }, signal)
    let sandbox = ''
    if (turn !== undefined) {
      // The turn's model request fails (the provider is a closed port); the turn's settings apply before it.
      await rpc.request('turn/start', { threadId: opened.thread.id, input: [{ type: 'text', text: 'hi', text_elements: [] }], ...turn }, signal)
      await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
      sandbox = ' (turn started)'
    }
    rpc.close()
    await handle.waitForExit()
    const added = readFileSync(join(home, 'config.toml'), 'utf8').slice(config.length).trim().replaceAll(workspace, '<workspace>')
    console.log(`${name}${sandbox}: ${added === '' ? 'no change' : added.replaceAll('\n', ' | ')}`)
  } catch (error: unknown) {
    console.log(`${name}: refused: ${error instanceof Error ? error.message : 'no reason'}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
await ctx.fiber.dispose()
