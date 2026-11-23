import type { FileSaveResult } from '@deepseek-ai/dsh-client-ui-file-actions/types'
/** Origin-scoped boot, native directory selection, host paths of picked files, and update presentation with native confirmation actions. */

import type { DesktopChannelState, DesktopChannelChangeResult } from '@deepseek-ai/dsh-client-ui-settings-general/types'
import type { DesktopShortcutInput, ShortcutConfigSnapshot, ShortcutSaveResult } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_IPC, SCHEME, parseDesktopHomeKind, type DshDesktopProductApi, type DesktopUpdatePresentation } from './ipc.ts'
import { PLATFORM_IPC } from './platform-ipc.ts'
import { markDocumentPlatform, syncWindowFullscreen } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'
import { createDesktopBrowserBridge } from './preload-browser.ts'
import type { FileDragHandle } from '@deepseek-ai/dsh-util-file-drag'

function createProductApi(): DshDesktopProductApi {
  return {
    protocolVersion: 1,
    fileActions: {
      save: request => ipcRenderer.invoke(DESKTOP_IPC.fileSave, request) as Promise<FileSaveResult>,
      readClipboardImage: url => ipcRenderer.invoke(DESKTOP_IPC.clipboardImageRead, url) as
        Promise<{ bytes: Uint8Array; mediaType: string }>,
    },
    browser: createDesktopBrowserBridge(),
    fileDrag: {
      prepare: (source, requestId) => ipcRenderer.invoke(DESKTOP_IPC.fileDragPrepare, source, requestId) as
        Promise<FileDragHandle | undefined>,
      cancel: (requestId) => { void ipcRenderer.invoke(DESKTOP_IPC.fileDragCancel, requestId).catch((_error: unknown) => {
        // Main-process shutdown cancels any remaining preparations.
      }) },
      start: handle => ipcRenderer.invoke(DESKTOP_IPC.fileDragStart, handle) as Promise<boolean>,
      release: (handle) => { void ipcRenderer.invoke(DESKTOP_IPC.fileDragRelease, handle).catch((_error: unknown) => {
        // Main-process shutdown also releases every prepared file.
      }) },
    },
    deviceInfo: () => ipcRenderer.invoke(DESKTOP_IPC.deviceInfo) as Promise<string>,
    keyboard: {
      closeWindow: revision => ipcRenderer.invoke(DESKTOP_IPC.shortcutsCloseWindow, revision) as Promise<void>,
      subscribe: (listener) => {
        const handle = (_event: Electron.IpcRendererEvent, input: DesktopShortcutInput): void => {
          if (input.kind === 'iframe') {
            const element = document.activeElement
            if (!(element instanceof HTMLIFrameElement) || !element.isConnected
              || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
            if (input.frameName === '' || element.name !== input.frameName) return
          }
          if (input.kind === 'webview') {
            const element = document.activeElement
            if (element?.matches('webview[data-sidebar-browser-frame]') !== true || !element.isConnected
              || input.frameName === '' || element.getAttribute('name') !== input.frameName) return
          }
          listener(input)
        }
        ipcRenderer.on(DESKTOP_IPC.shortcutsInput, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsInput, handle) }
      },
    },
    shortcuts: {
      get: definitions => ipcRenderer.invoke(DESKTOP_IPC.shortcutsGet, definitions) as Promise<ShortcutConfigSnapshot>,
      edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_IPC.shortcutsEdit, edit, revision) as Promise<ShortcutSaveResult>,
      recording: active => ipcRenderer.invoke(DESKTOP_IPC.shortcutsRecording, active) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, snapshot: ShortcutConfigSnapshot): void => { listener(snapshot) }
        ipcRenderer.on(DESKTOP_IPC.shortcutsChanged, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.shortcutsChanged, handle) }
      },
    },
    updates: {
      channels: {
        get: () => ipcRenderer.invoke(DESKTOP_IPC.updatesChannelGet) as Promise<DesktopChannelState>,
        set: channel => ipcRenderer.invoke(DESKTOP_IPC.updatesChannelSet, channel) as Promise<DesktopChannelChangeResult>,
        subscribe(listener) {
          const handle = (_event: Electron.IpcRendererEvent, state: DesktopChannelState): void => { listener(state) }
          ipcRenderer.on(DESKTOP_IPC.updatesChannelChanged, handle)
          return () => { ipcRenderer.off(DESKTOP_IPC.updatesChannelChanged, handle) }
        },
      },
      status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
      open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
      subscribe(listener) {
        const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
        ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
        return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
      },
    },
  }
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('dshOnboarding', {
    hasApiKey: () => ipcRenderer.invoke(DESKTOP_IPC.onboardingApiKey) as Promise<boolean>,
    setActive: (active: boolean) => { ipcRenderer.send(DESKTOP_IPC.onboardingActive, active) },
  })
  ipcRenderer.on(DESKTOP_IPC.enterWorkspace, () => {
    const body = document.body
    const previous = body.getAttribute('tabindex')
    body.tabIndex = -1
    body.focus({ preventScroll: true })
    if (previous === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', previous)
  })
  syncWindowsAppearance()
  // Where the home runs: a value only, never a credential. The studio reads it to choose what to show; the home's own
  // checks stay the authority. The key is always claimed on the application document, with no `homeKind` when the kind
  // cannot be read, so a page script cannot plant a value of its own (the preload runs before any page script).
  const homeKind = parseDesktopHomeKind(ipcRenderer.sendSync(DESKTOP_IPC.homeKind))
  contextBridge.exposeInMainWorld('delorunDesktop', Object.freeze(homeKind === undefined ? {} : { homeKind }))
  // The native dialog browses this PC's Windows paths, which a home in WSL or on another machine cannot open, so only
  // the bundled Host gets it; the studio's own browse picker serves every other home.
  if (homeKind === 'bundled') {
    contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
      pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
    })
  }
  // The composer cites dropped, picked, and pasted files and folders that
  // have a real path as `@path` references instead of uploading them; a
  // File without one (pasted bytes) answers '' and uploads as before. A home
  // in WSL gets the path as the distribution sees it, translated by main
  // (a refused path answers '' and main tells the person why); a home on
  // another machine has no path for a file of this PC.
  contextBridge.exposeInMainWorld('__DSH_HOST_PATHS__', {
    pathFor: (file: File) => {
      const nativePath = webUtils.getPathForFile(file)
      if (homeKind === 'bundled') return nativePath
      if (homeKind !== 'wsl' || nativePath === '') return ''
      const translated: unknown = ipcRenderer.sendSync(DESKTOP_IPC.hostPath, nativePath)
      return typeof translated === 'string' ? translated : ''
    },
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
  contextBridge.exposeInMainWorld('dshPlatform', {
    open: (page: 'usage' | 'top-up', bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.open, page, bounds),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(PLATFORM_IPC.bounds, bounds),
    close: () => ipcRenderer.invoke(PLATFORM_IPC.close),
  })
}

markDocumentPlatform()
syncWindowFullscreen()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' && process.isMainFrame ? createProductApi() : { protocolVersion: 1 })

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  contextBridge.exposeInMainWorld('__DSH_LOCALE__', {
    read: () => ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap),
    onChange: (locale: string) => { ipcRenderer.send(DESKTOP_IPC.localeChanged, locale) },
  })
}
