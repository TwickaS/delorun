import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkspacePackages, selectClosurePackages, selectedBundles } from '../../src/closure/plugin-set.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const packages = readWorkspacePackages(root)
const selection = selectClosurePackages(packages)

describe('the packages a runtime closure carries (owner decision A399)', () => {
  it('carries the Claude Code and Codex agents and experimental packages, selected from the workspace', () => {
    expect(selection.included).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-subagent-claude-code',
      '@deepseek-ai/dsh-subagent-codex',
      '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
      '@delorun/plugin-main-chat',
    ]))
  })

  it('leaves out test infrastructure, build tools, SDK clients and Web-distribution libraries, each with a reason', () => {
    const left = new Map(selection.excluded.map(each => [each.name, each.reason]))
    for (const name of ['@deepseek-ai/dsh-tool-testkit', '@deepseek-ai/dsh-typert-generator', '@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh-client-ui-dockkit']) {
      expect(left.get(name), name).toBeTruthy()
    }
    expect(selection.included).not.toContain('@deepseek-ai/dsh-tool-testkit')
  })

  it('names the agent bundles for the install anchor, so Plugins lists them switched off', () => {
    expect(selectedBundles(packages, selection)).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-subagent-claude-code', '@deepseek-ai/dsh-subagent-codex']))
  })

  it('has the same package in exactly one of the two lists', () => {
    const names = new Set(selection.included)
    expect(selection.excluded.filter(each => names.has(each.name))).toEqual([])
    expect(join(root, 'packages')).toBeTruthy()
  })
})
