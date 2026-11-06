/** Shared settings viewing state for its mouse, command and `ctx.settingsShell` entry points, with an explicitly opened onboarding step. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

type State = { open: boolean; activeId: string | undefined; onboarding: string | undefined }
type Actions = {
  open(draft: State): void
  close(draft: State): void
  select(draft: State, id: string): void
  openSection(draft: State, id: string): void
  requestOnboarding(draft: State, id: string): void
  finishOnboarding(draft: State): void
}

/**
 * Declare the settings dialog state and its complete mutation API.
 * @returns one root-scoped store handle for the settings shell.
 */
export function createSettingsShellStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ open: false, activeId: undefined as string | undefined, onboarding: undefined as string | undefined }),
    actions: {
      open: (d) => { d.open = true },
      close: (d) => { d.open = false; d.activeId = undefined },
      select: (d, id: string) => { d.activeId = id },
      openSection: (d, id: string) => { d.activeId = id; d.open = true },
      // An explicitly opened onboarding step owns the viewport, so the panel closes under it.
      requestOnboarding: (d, id: string) => { d.onboarding = id; d.open = false; d.activeId = undefined },
      finishOnboarding: (d) => { d.onboarding = undefined },
    },
  })
}
