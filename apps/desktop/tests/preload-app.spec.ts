// @vitest-environment jsdom
import type { DesktopFileDrag, FileDragHandle, FileDragRequestId } from '@deepseek-ai/dsh-util-file-drag'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syncWindowsAppearance } from '../src/preload-windows.ts'
import { DESKTOP_IPC, type DshDesktopProductApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn(), sendSync: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))
vi.mock('electron', () => electron)
vi.mock('../src/preload-platform.ts', () => ({ markDocumentPlatform: vi.fn(), syncWindowFullscreen: vi.fn() }))
vi.mock('../src/preload-theme.ts', () => ({ syncNativeTheme: vi.fn() }))
vi.mock('../src/preload-windows.ts', () => ({ syncWindowsAppearance: vi.fn() }))

/** What main answers the synchronous home-kind and host-path requests. */
function answerMain(kind: unknown, hostPath: (nativePath: string) => unknown = () => ''): void {
  electron.ipcRenderer.sendSync.mockImplementation((channel: string, nativePath?: string) => {
    if (channel === DESKTOP_IPC.homeKind) return kind
    return channel === DESKTOP_IPC.hostPath ? hostPath(nativePath ?? '') : undefined
  })
}
beforeEach(() => {
  vi.stubGlobal('process', { ...process, isMainFrame: true })
  answerMain('bundled')
})
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules() })

it('reads only native login API-key presence through the onboarding bridge', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  electron.ipcRenderer.invoke.mockResolvedValueOnce(true)
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshOnboarding')?.[1] as { hasApiKey(): Promise<boolean> }
  expect(await api.hasApiKey()).toBe(true)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.onboardingApiKey)
})

it('exposes onboarding size activation to the application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshOnboarding')?.[1] as { setActive(active: boolean): void }
  api.setActive(true)
  api.setActive(false)
  expect(electron.ipcRenderer.send.mock.calls).toEqual([[DESKTOP_IPC.onboardingActive, true], [DESKTOP_IPC.onboardingActive, false]])
})

it('routes original-file requests through the trusted application bridge', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const request = { url: 'https://images.example/original.gif', name: 'image.gif', mode: 'download' as const }
  await api.fileActions.save(request)
  await api.fileActions.readClipboardImage('https://images.example/original.gif')
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.fileSave, request],
    [DESKTOP_IPC.clipboardImageRead, 'https://images.example/original.gif'],
  ])
})

it('limits product documents to update status and a native confirmation action', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await api.updates.status()
  await api.updates.open()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([[DESKTOP_IPC.updatesStatus], [DESKTOP_IPC.updatesOpen]])
  expect(api).not.toHaveProperty('plugins')
  expect(api).not.toHaveProperty('backend')
  expect(api.updates).not.toHaveProperty('install')
  const listener = vi.fn()
  const dispose = api.updates.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.updatesPresentation)?.[1] as
    (event: unknown, state: unknown) => void
  handler({}, { visible: false })
  expect(listener).toHaveBeenCalledWith({ visible: false })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.updatesPresentation, handler)
})

it.each(['dsh-app://shell/plugin-manager.html', 'dsh-app://other/index.html', 'https://shell/startup.html', 'http://example.com/'])('exposes only the carrier marker to %s', async (url) => {
  vi.stubGlobal('location', new URL(url))
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
  expect(electron.ipcRenderer.on.mock.calls.some(([channel]) => channel === DESKTOP_IPC.browserOpenRequested)).toBe(false)
})

it('reads the local machine description only from the application main frame', async () => {
  const description = 'platform=darwin; os=15.6; app_arch=arm64; cpu=Apple M4; memory_gib=32.0'
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  electron.ipcRenderer.invoke.mockResolvedValue(description)
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await expect(api.deviceInfo()).resolves.toBe(description)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.deviceInfo)
  vi.resetModules()
  electron.contextBridge.exposeInMainWorld.mockClear()
  vi.stubGlobal('process', { ...process, isMainFrame: false })
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
})

it('exposes asynchronous boot only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktopBoot')?.[1] as { ready(): Promise<unknown>; failed(message: string): Promise<void> }
  await api.ready()
  await api.failed('client mount failed')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.bootFailed, 'client mount failed')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.boot)
  vi.resetModules()
  electron.contextBridge.exposeInMainWorld.mockClear()
  vi.stubGlobal('location', new URL('https://other.example/'))
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === 'dshDesktopBoot')).toBe(false)
})

it('exposes a directory picker only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === '__DSH_DIRECTORY_PICKER__')?.[1] as { pick(): Promise<string | null> }
  electron.ipcRenderer.invoke.mockResolvedValue('/workspace')
  await expect(api.pick()).resolves.toBe('/workspace')
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.directoryPick)
  for (const url of ['dsh-app://shell/startup.html', 'https://example.com/']) {
    vi.resetModules()
    electron.contextBridge.exposeInMainWorld.mockClear()
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === '__DSH_DIRECTORY_PICKER__')).toBe(false)
  }
})

it('reports host paths of picked files only to the local application document', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === '__DSH_HOST_PATHS__')?.[1] as { pathFor(file: File): string }
  const picked = new File(['x'], 'notes.md')
  electron.webUtils.getPathForFile.mockReturnValue('/Users/me/notes.md')
  expect(api.pathFor(picked)).toBe('/Users/me/notes.md')
  expect(electron.webUtils.getPathForFile).toHaveBeenCalledExactlyOnceWith(picked)
  for (const url of ['dsh-app://shell/startup.html', 'https://example.com/']) {
    vi.resetModules()
    electron.contextBridge.exposeInMainWorld.mockClear()
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === '__DSH_HOST_PATHS__')).toBe(false)
  }
})

it.each(['dsh-app://app/', 'dsh-app://shell/plugin-manager.html', 'https://example.com/'])(
  'installs Windows appearance only for the application document (%s)', async (url) => {
    vi.stubGlobal('location', new URL(url))
    await import('../src/preload-app.ts')
    expect(syncWindowsAppearance).toHaveBeenCalledTimes(url === 'dsh-app://app/' ? 1 : 0)
  },
)

it('moves workspace-entry focus to the document without changing keyboard tab order', async () => {
  const dom = new JSDOM('<body><button>Sidebar</button><input></body>')
  try {
    vi.stubGlobal('document', dom.window.document)
    vi.stubGlobal('location', new URL('dsh-app://app/'))
    await import('../src/preload-app.ts')
    const enter = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.enterWorkspace)![1] as () => void
    const button = dom.window.document.querySelector('button')!
    button.focus()
    enter()
    expect(dom.window.document.activeElement).toBe(dom.window.document.body)
    expect(dom.window.document.body.hasAttribute('tabindex')).toBe(false)
    expect(button.tabIndex).toBe(0)
    dom.window.document.body.setAttribute('tabindex', '-1')
    button.focus()
    enter()
    expect(dom.window.document.body.getAttribute('tabindex')).toBe('-1')
  } finally { dom.window.close() }
})

it('exposes constrained shortcut operations and releases configuration subscriptions', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await api.shortcuts.get([])
  expect(api.shortcuts).not.toHaveProperty('reload')
  await api.shortcuts.recording(true)
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsGet, [])
  expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsRecording, true)
  const listener = vi.fn()
  const off = api.shortcuts.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsChanged)![1] as
    (event: unknown, state: unknown) => void
  handler({}, { status: 'ready' })
  expect(listener).toHaveBeenCalledWith({ status: 'ready' })
  off(); expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsChanged, handler)
})

it('withholds the product API from same-origin child frames', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  vi.stubGlobal('process', { ...process, isMainFrame: false })
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('dshDesktop', { protocolVersion: 1 })
})

it('forwards only the focused product iframe and releases native input subscriptions', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const listener = vi.fn()
  const off = api.keyboard.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsInput)![1] as
    (event: unknown, state: unknown) => void
  const input = { kind: 'iframe', frameName: 'preview', revision: 'current' }
  handler({}, input)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frame.name = 'preview'
  frame.focus()
  handler({}, input)
  expect(listener).not.toHaveBeenCalled()
  frame.setAttribute('data-html-preview', '')
  handler({}, { ...input, frameName: 'stale' })
  handler({}, { ...input, frameName: '' })
  expect(listener).not.toHaveBeenCalled()
  handler({}, input)
  expect(listener).toHaveBeenCalledExactlyOnceWith(input)
  frame.remove()
  handler({}, input)
  expect(listener).toHaveBeenCalledTimes(1)
  const menu = { kind: 'menu', commandId: 'page.close', revision: 'current' }
  handler({}, menu)
  expect(listener).toHaveBeenLastCalledWith(menu)
  off()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.shortcutsInput, handler)
})

it('forwards browser guest input only for the focused live webview lease', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const listener = vi.fn()
  const off = api.keyboard.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([name]) => name === DESKTOP_IPC.shortcutsInput)![1] as
    (event: unknown, state: unknown) => void
  const input = { kind: 'webview', frameName: 'guest', revision: 'current' }
  const frame = document.createElement('webview')
  frame.tabIndex = 0
  frame.setAttribute('name', 'guest')
  document.body.append(frame)
  frame.focus()
  handler({}, input)
  expect(listener).not.toHaveBeenCalled()
  frame.setAttribute('data-sidebar-browser-frame', 'webview')
  handler({}, { ...input, frameName: '' })
  handler({}, { ...input, frameName: 'old' })
  expect(listener).not.toHaveBeenCalled()
  handler({}, input)
  expect(listener).toHaveBeenCalledExactlyOnceWith(input)
  const other = document.createElement('input')
  document.body.append(other)
  other.focus()
  handler({}, input)
  frame.remove()
  handler({}, input)
  expect(listener).toHaveBeenCalledOnce()
  off()
})

it('prepares original image bytes and starts native drags without renderer filesystem paths', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  const bytes = new Uint8Array([137, 80, 78, 71])
  electron.ipcRenderer.invoke.mockResolvedValueOnce('image-handle').mockResolvedValueOnce(true).mockResolvedValueOnce(undefined)
  await expect(api.fileDrag.prepare({ kind: 'bytes', bytes, name: 'original.png', mediaType: 'image/png' }, 'request' as FileDragRequestId)).resolves.toBe('image-handle')
  await expect(api.fileDrag.start('image-handle' as FileDragHandle)).resolves.toBe(true)
  api.fileDrag.release('image-handle' as FileDragHandle)
  api.fileDrag.cancel('request' as FileDragRequestId)
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.fileDragPrepare, { kind: 'bytes', bytes, name: 'original.png', mediaType: 'image/png' }, 'request'],
    [DESKTOP_IPC.fileDragStart, 'image-handle'],
    [DESKTOP_IPC.fileDragRelease, 'image-handle'],
    [DESKTOP_IPC.fileDragCancel, 'request'],
  ])
})

// The Host and Client compiler faces share no runtime entry; this assignment checks their image protocol.
const imageProtocol = (value: import('../src/ipc.ts').DshDesktopProductApi['fileDrag']): DesktopFileDrag => value
const imageProtocolBack = (value: DesktopFileDrag): import('../src/ipc.ts').DshDesktopProductApi['fileDrag'] => value
void imageProtocol
void imageProtocolBack


it('exposes channel choices and scoped subscriptions without exposing updater objects', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls.find(([name]) => name === 'dshDesktop')?.[1] as DshDesktopProductApi
  await api.updates.channels.get()
  await api.updates.channels.set('stable')
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([[DESKTOP_IPC.updatesChannelGet], [DESKTOP_IPC.updatesChannelSet, 'stable']])
  const listener = vi.fn()
  const dispose = api.updates.channels.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls.find(([channel]) => channel === DESKTOP_IPC.updatesChannelChanged)?.[1] as
    (event: unknown, state: unknown) => void
  const state = { channel: 'stable', packagedChannel: 'nightly', changing: false }
  handler({}, state)
  expect(listener).toHaveBeenCalledWith(state)
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.updatesChannelChanged, handler)
})

const exposed = (name: string): unknown => electron.contextBridge.exposeInMainWorld.mock.calls
  .find(([exposedName]) => exposedName === name)?.[1]

it.each(['bundled', 'wsl', 'remote'] as const)('tells the application document the home kind %s as a plain value', async (kind) => {
  answerMain(kind)
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  expect((exposed('delorunDesktop') as { homeKind: string }).homeKind).toBe(kind)
  expect(electron.ipcRenderer.sendSync).toHaveBeenCalledWith(DESKTOP_IPC.homeKind)
})

it.each([undefined, null, 'local', 7, { kind: 'wsl' }])('still claims delorunDesktop, with no homeKind, when main answers %j', async (answer) => {
  answerMain(answer)
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const claims = electron.contextBridge.exposeInMainWorld.mock.calls.filter(([name]) => name === 'delorunDesktop')
  expect(claims).toHaveLength(1)
  const api = claims[0]![1] as Record<string, unknown>
  expect(Object.keys(api)).toEqual([])
  expect(api).not.toHaveProperty('homeKind')
  expect(Object.isFrozen(api)).toBe(true)
  expect(exposed('__DSH_DIRECTORY_PICKER__')).toBeUndefined()
})

it.each([undefined, 'local', 'bundled', 'wsl', 'remote'])('leaves a page script no way to write or redefine the claimed key (main answers %j)', async (answer) => {
  answerMain(answer)
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = exposed('delorunDesktop') as Record<string, unknown>
  const before = { ...api }
  expect(() => { (api as { homeKind?: string }).homeKind = 'remote' }).toThrow(TypeError)
  expect(() => { Object.defineProperty(api, 'homeKind', { value: 'bundled' }) }).toThrow(TypeError)
  expect(() => { (api as { extra?: string }).extra = 'x' }).toThrow(TypeError)
  if ('homeKind' in api) expect(() => { delete (api as { homeKind?: string }).homeKind }).toThrow(TypeError)
  expect({ ...api }).toEqual(before)
  // The preload claims the key once, as one call; a second claim by another call would be a second owner.
  expect(electron.contextBridge.exposeInMainWorld.mock.calls.filter(([name]) => name === 'delorunDesktop')).toHaveLength(1)
})

it.each(['dsh-app://shell/startup.html', 'https://example.com/'])('asks main for no home kind from %s', async (url) => {
  vi.stubGlobal('location', new URL(url))
  await import('../src/preload-app.ts')
  expect(electron.contextBridge.exposeInMainWorld.mock.calls.some(([name]) => name === 'delorunDesktop')).toBe(false)
  expect(electron.ipcRenderer.sendSync).not.toHaveBeenCalled()
})

it.each(['wsl', 'remote'] as const)('does not expose the native directory picker for a %s home', async (kind) => {
  answerMain(kind)
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  expect(exposed('__DSH_DIRECTORY_PICKER__')).toBeUndefined()
})

it('gives a home in WSL the path main translated, and nothing when main refuses it', async () => {
  answerMain('wsl', nativePath => nativePath === 'C:\\Users\\me\\notes.md' ? '/mnt/c/Users/me/notes.md' : '')
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const api = exposed('__DSH_HOST_PATHS__') as { pathFor(file: File): string }
  const dropped = new File(['x'], 'notes.md')
  electron.webUtils.getPathForFile.mockReturnValueOnce('C:\\Users\\me\\notes.md')
  expect(api.pathFor(dropped)).toBe('/mnt/c/Users/me/notes.md')
  expect(electron.ipcRenderer.sendSync).toHaveBeenLastCalledWith(DESKTOP_IPC.hostPath, 'C:\\Users\\me\\notes.md')
  electron.webUtils.getPathForFile.mockReturnValueOnce('\\\\server\\share\\notes.md')
  expect(api.pathFor(dropped)).toBe('')
  electron.webUtils.getPathForFile.mockReturnValueOnce('')
  electron.ipcRenderer.sendSync.mockClear()
  expect(api.pathFor(dropped)).toBe('')
  expect(electron.ipcRenderer.sendSync).not.toHaveBeenCalled()
})

it('reports a path of this PC to no home that is not on it, and never a non-text answer from main', async () => {
  answerMain('remote')
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  electron.webUtils.getPathForFile.mockReturnValue('C:\\Users\\me\\notes.md')
  expect((exposed('__DSH_HOST_PATHS__') as { pathFor(file: File): string }).pathFor(new File(['x'], 'notes.md'))).toBe('')
  vi.resetModules()
  electron.contextBridge.exposeInMainWorld.mockClear()
  answerMain('wsl', () => 42)
  await import('../src/preload-app.ts')
  expect((exposed('__DSH_HOST_PATHS__') as { pathFor(file: File): string }).pathFor(new File(['x'], 'notes.md'))).toBe('')
})

it.each(['bundled', 'wsl', 'remote'] as const)('exposes the %s home kind read-only, as a lone text value with no credential', async (kind) => {
  answerMain(kind)
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  await import('../src/preload-app.ts')
  const calls = electron.contextBridge.exposeInMainWorld.mock.calls.filter(([name]) => name === 'delorunDesktop')
  expect(calls).toHaveLength(1)
  const api = calls[0]![1] as Record<string, unknown>
  expect(Object.isFrozen(api)).toBe(true)
  expect(Object.keys(api)).toEqual(['homeKind'])
  expect(api.homeKind).toBe(kind)
  expect(() => { (api as { homeKind: string }).homeKind = 'wsl' }).toThrow(TypeError)
  expect(() => { (api as { cookie?: string }).cookie = 'x' }).toThrow(TypeError)
  expect(api.homeKind).toBe(kind)
  expect(JSON.stringify(api)).toBe(`{"homeKind":"${kind}"}`)
})
