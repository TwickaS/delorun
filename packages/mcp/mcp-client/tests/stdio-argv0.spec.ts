/**
 * @file A stdio server spawned through the SDK transport sees the configured
 * `argv0` while the configured `command` is the file that runs.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StdioConfig } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { createTransport } from '@deepseek-ai/dsh-mcp-client/src/transport.ts'

describe.skipIf(process.platform === 'win32')('the stdio spawn', () => {
  let root: string
  const node = realpathSync(process.execPath)

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-argv0-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Spawn Node through the transport with a script that records its argv[0] and executable.
   * @param argv0 - the `argv0` to configure, if any.
   * @returns the child's `process.argv0` and `process.execPath`.
   */
  async function spawnRecording(argv0: string | undefined): Promise<[string, string]> {
    const out = join(root, 'seen.json')
    const config: StdioConfig = {
      transport: 'stdio',
      serverName: 'srv',
      command: node,
      ...argv0 === undefined ? {} : { argv0 },
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.argv0, process.execPath]))`],
      env: {},
      cwd: root,
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    const transport = createTransport(config)
    await transport.start()
    try {
      return await vi.waitFor(() => JSON.parse(readFileSync(out, 'utf8')) as [string, string])
    } finally {
      await transport.close()
    }
  }

  it('runs the configured file under the configured argv0', async () => {
    expect(await spawnRecording('python')).toEqual(['python', node])
  })

  it('shows the server the configured command when no argv0 is configured', async () => {
    expect(await spawnRecording(undefined)).toEqual([node, node])
  })
})
