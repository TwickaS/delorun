import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { DEMO_WORKSPACES } from '../src/demo-home/content.ts'
import { exportArchive, exportedConversation, writeDemoChats } from '../src/demo-home.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('demo-home', () => {
  it('writes the DeepSeek export format with the chats ordered by their age', () => {
    const now = Date.UTC(2026, 10, 16, 12)
    const workspace = DEMO_WORKSPACES[0]!
    const files = unzipSync(exportArchive(workspace, now))
    expect(Object.keys(files).sort()).toEqual(['chat_session_index.json', 'chat_sessions/garden-planner-1.json', 'chat_sessions/garden-planner-2.json', 'chat_sessions/garden-planner-3.json', 'manifest.json'])
    const chat = exportedConversation('x', workspace.chats[0]!, now) as { messages: { id: number, parent_id: number | null }[] }
    expect(chat.messages.map(message => [message.id, message.parent_id])).toEqual([[1, null], [2, 1], [3, 2], [4, 3]])
  })

  it('invents its workspaces and chats without a real path, name, address or key', () => {
    const text = JSON.stringify(DEMO_WORKSPACES)
    expect(text).not.toMatch(/\/home\/|\/Users\/|@[a-z0-9-]+\.[a-z]|sk-[A-Za-z0-9]{8}/u)
  })

  it('registers the workspaces and stores their chats in a new home without a model', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'demo-home-')))
    roots.push(root)
    const home = join(root, 'home')
    const made = await writeDemoChats(home, join(root, 'projects'), Date.now())
    expect(made.workspaces.map(workspace => workspace.chats)).toEqual(DEMO_WORKSPACES.map(workspace => workspace.chats.length))
    expect(existsSync(join(root, 'projects', 'garden-planner', 'beds.json'))).toBe(true)
    expect(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8')).toContain('recipe-box')
    expect(readdirSync(join(home, 'sessions')).length).toBeGreaterThan(0)
    expect(readdirSync(root).filter(name => name.startsWith('.demo-home-'))).toEqual([])
  })
})
