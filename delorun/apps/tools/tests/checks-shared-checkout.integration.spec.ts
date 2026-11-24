/**
 * The shared checkout guard: a push from a linked worktree is refused while the clone's main worktree holds changes to
 * tracked content, and a run inside the main worktree is never refused.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
import { mainWorktree, sharedCheckoutDirt, sharedCheckoutNote, sharedCheckoutRefusal, worktreeDirt } from '../src/checks/shared-checkout.ts'
import { refuseSharedCheckout } from '../src/run-checks.ts'
import { scratchRepo, type Scratch } from './gates/support.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

/**
 * A clone whose main worktree holds one commit, and a linked worktree of it.
 * @param test - the running test, whose teardown removes the clone.
 * @returns the main worktree and the linked worktree's path.
 */
function cloneWithWorktree(test: TestContext): { main: Scratch; linked: string } {
  const main = scratchRepo(test)
  main.commit({ 'README.md': '# fixture\n', 'src/app.ts': 'export const app = 1\n' })
  const linked = mkdtempSync(join(tmpdir(), 'delorun-linked-'))
  roots.push(linked)
  rmSync(linked, { recursive: true, force: true })
  main.run(['worktree', 'add', '-q', '-b', 'lane', linked])
  return { main, linked }
}

describe('the shared checkout guard', () => {
  it('names the clone\'s main worktree, not the worktree the run happens in', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    expect(mainWorktree(linked)).toBe(main.root)
    expect(mainWorktree(main.root)).toBe(main.root)
  })

  it('refuses a push from a linked worktree while the shared checkout holds a change to tracked content', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    expect(sharedCheckoutRefusal(linked)).toBeUndefined()
    writeFileSync(join(main.root, 'README.md'), '')
    const refusal = sharedCheckoutRefusal(linked)
    expect(refusal).toContain(main.root)
    expect(refusal).toContain('README.md')
    expect(refusal).toContain('commit or restore them there before pushing')
  })

  it('refuses a staged change and a deletion in the shared checkout', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    writeFileSync(join(main.root, 'src/app.ts'), 'export const app = 2\n')
    main.run(['add', 'src/app.ts'])
    expect(sharedCheckoutRefusal(linked)).toContain('src/app.ts')
    main.run(['reset', '-q', '--hard', 'HEAD'])
    rmSync(join(main.root, 'README.md'))
    expect(sharedCheckoutRefusal(linked)).toContain('README.md')
  })

  it('never refuses a run inside the shared checkout itself, which the checks already measure', (test) => {
    const { main } = cloneWithWorktree(test)
    writeFileSync(join(main.root, 'README.md'), '')
    expect(sharedCheckoutRefusal(main.root)).toBeUndefined()
    expect(sharedCheckoutDirt(main.root)).toBeUndefined()
  })

  it('names untracked files in a note without refusing the push', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    writeFileSync(join(main.root, 'stray.pyc'), 'x')
    expect(sharedCheckoutRefusal(linked)).toBeUndefined()
    expect(sharedCheckoutNote(linked)).toContain('stray.pyc')
    expect(sharedCheckoutNote(linked)).toContain('do not refuse this push')
  })

  it('reads a rename as one tracked change and leaves the original path out', (test) => {
    const { main } = cloneWithWorktree(test)
    main.run(['mv', 'README.md', 'README2.md'])
    expect(worktreeDirt(main.root).tracked).toEqual(['README2.md'])
    expect(worktreeDirt(main.root).untracked).toEqual([])
  })

  it('stops the pre-push run before any check starts, and only warns about untracked files', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    const warned: string[] = []
    expect(() => { refuseSharedCheckout(linked, line => warned.push(line)) }).not.toThrow()
    expect(warned).toEqual([])
    writeFileSync(join(main.root, 'stray.pyc'), 'x')
    refuseSharedCheckout(linked, line => warned.push(line))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('stray.pyc')
    writeFileSync(join(main.root, 'README.md'), '')
    expect(() => { refuseSharedCheckout(linked, line => warned.push(line)) }).toThrow(/has uncommitted changes to README\.md/)
  })

  it('names three paths and counts the rest', (test) => {
    const { main, linked } = cloneWithWorktree(test)
    for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(main.root, `${name}.txt`), 'x')
    main.run(['add', '-A'])
    const refusal = sharedCheckoutRefusal(linked)
    expect(refusal).toContain('a.txt, b.txt, c.txt and 2 more')
  })
})
