import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceLocationHomes, workspaceLocationMessage, workspaceLocationProblem, type WorkspaceLocationHomes, type WorkspaceLocationProblem } from '../src/index.ts'

let osHome: string
let homes: WorkspaceLocationHomes

beforeEach(() => {
  osHome = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-location-')))
  homes = { osHome, deloHome: join(osHome, '.delo'), stockHome: join(osHome, '.dsh') }
  mkdirSync(homes.deloHome)
  mkdirSync(homes.stockHome)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(osHome, { recursive: true, force: true })
})

describe('workspaceLocationProblem', () => {
  it('accepts a folder inside the home directory, created or not', async () => {
    mkdirSync(join(osHome, 'projects'))
    expect(await workspaceLocationProblem(join(osHome, 'projects'), homes)).toBeUndefined()
    expect(await workspaceLocationProblem(join(osHome, 'Delo', 'default-workspace'), homes)).toBeUndefined()
  })

  it('refuses the filesystem root', async () => {
    expect(await workspaceLocationProblem(parse(osHome).root, homes)).toBe('filesystem-root')
  })

  it('refuses the home directory itself', async () => {
    expect(await workspaceLocationProblem(osHome, homes)).toBe('home-directory')
    expect(await workspaceLocationProblem(`${osHome}/`, homes)).toBe('home-directory')
  })

  it('refuses the Delo home and a folder inside it', async () => {
    expect(await workspaceLocationProblem(homes.deloHome, homes)).toBe('delo-home')
    expect(await workspaceLocationProblem(join(homes.deloHome, 'profiles', 'default'), homes)).toBe('delo-home')
  })

  it('refuses a folder that contains the Delo home', async () => {
    const deloHome = join(osHome, 'work', 'delo-home')
    mkdirSync(deloHome, { recursive: true })
    expect(await workspaceLocationProblem(join(osHome, 'work'), { ...homes, deloHome })).toBe('contains-delo-home')
  })

  it('refuses the stock home and a folder inside it', async () => {
    expect(await workspaceLocationProblem(homes.stockHome, homes)).toBe('stock-home')
    expect(await workspaceLocationProblem(join(homes.stockHome, 'profiles'), homes)).toBe('stock-home')
  })

  it('refuses a folder that contains the stock home', async () => {
    const stockHome = join(osHome, 'tools', '.dsh')
    mkdirSync(stockHome, { recursive: true })
    expect(await workspaceLocationProblem(join(osHome, 'tools'), { ...homes, stockHome })).toBe('contains-stock-home')
  })

  it('resolves a symbolic link before it compares', async () => {
    symlinkSync(osHome, join(homes.stockHome, 'to-home'))
    expect(await workspaceLocationProblem(join(homes.stockHome, 'to-home'), homes)).toBe('home-directory')
    symlinkSync(homes.deloHome, join(osHome, 'delo-link'))
    expect(await workspaceLocationProblem(join(osHome, 'delo-link', 'sessions'), homes)).toBe('delo-home')
  })

  it('compares with case on Linux', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(await workspaceLocationProblem(osHome.toUpperCase(), homes)).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not take a sibling whose name starts with a home\'s name for a folder inside it', async () => {
    expect(await workspaceLocationProblem(join(osHome, '.delo-projects'), homes)).toBeUndefined()
  })

  it('compares without case where the platform\'s filesystem does', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      expect(await workspaceLocationProblem(osHome.toUpperCase(), homes)).toBe('home-directory')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('refuses a relative path', async () => {
    expect(await workspaceLocationProblem('projects', homes)).toBe('not-absolute')
  })

  it('names the process\'s own homes', () => {
    vi.stubEnv('HOME', osHome)
    vi.stubEnv('USERPROFILE', osHome)
    expect(workspaceLocationHomes(homes.deloHome)).toEqual(homes)
  })
})

describe('workspaceLocationMessage', () => {
  it('gives every problem a sentence with a way forward', () => {
    const problems: WorkspaceLocationProblem[] = ['filesystem-root', 'home-directory', 'delo-home', 'contains-delo-home', 'stock-home', 'contains-stock-home', 'not-absolute']
    for (const problem of problems) expect(workspaceLocationMessage(problem)).toMatch(/\.$/)
    expect(workspaceLocationMessage('home-directory')).toContain('create or choose a folder inside it')
  })
})
