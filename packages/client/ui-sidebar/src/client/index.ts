/** Registers the sidebar shell and global panel navigation. */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SidebarLeadPanel, SidebarPanelMetadata, SidebarHoverPeek, SidebarRootInjected, SidebarSectionInjected } from './contract/slots.ts'
import { createPanelPins } from './panel-pins.ts'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import { PanelIcon } from './PanelIcon.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBackdropOwnerProps, SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarHoverPeek, SidebarLeadPanel,
  SidebarPanelActionEntry, SidebarPanelActionsOwnerProps, SidebarPanelIconOwnerProps, SidebarPanelMetadata,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSessionActionOwnerProps,
  SidebarSettingsOwnerProps, SectionScroller, SidebarSectionHookContext, SidebarSectionInjected, UseSectionScroller,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

/** Where the sidebar lists the global panels (Plugins, Automation tasks and the like): under New Session, or in its foot. */
export type SidebarPanelPlacement = 'top' | 'footer'

/** How a distribution arranges the sidebar. */
export interface SidebarLayout {
  /**
   * List the global panels at `placement` until the returned disposer runs; the latest call wins.
   * @param placement - where the panel list goes.
   * @returns the disposer that restores the previous placement.
   */
  setPanelPlacement(placement: SidebarPanelPlacement): () => void
  /**
   * Lead the sidebar with one global panel's row, above New Session and out of the panel list, until the returned
   * disposer runs; the latest call wins.
   * @param panelId - a registered `sidebar.panellist` id.
   * @param current - also marks the row current while it reads true, for a panel that hands the main view to a
   *   Session it stands for, which closes the panel.
   * @returns the disposer that restores the previous lead.
   */
  setLeadPanel(panelId: MainPanelId, current?: ObservableSnapshot<boolean>): () => void
  /**
   * Show or hide the wide sidebar's New Session button until the returned disposer runs, for a chat list that offers
   * its own; the folded rail keeps the button. The latest call wins.
   * @param shown - whether the wide sidebar shows the button.
   * @returns the disposer that restores the previous choice.
   */
  setNewSessionButton(shown: boolean): () => void
  /**
   * Lay the wide sidebar's foot out as one row until the returned disposer runs: the `sidebar.settings` seat, the panel
   * list when it sits in the foot, then the `sidebar.footer.action` entries at the row's end, told they sit inline.
   * Otherwise the footer actions stack above the settings row. The latest call wins.
   * @param row - whether the foot is one row.
   * @returns the disposer that restores the previous choice.
   */
  setFootRow(row: boolean): () => void
  /**
   * Set whether dwelling on the collapsed rail opens the hover peek and how long the pointer rests first, until the
   * returned disposer runs; the latest call wins. Without a call the peek is on with a 350 ms dwell. A change applies
   * to a rail already mounted, and an open peek closes when the peek is turned off.
   * @param peek - whether the peek opens and the dwell in milliseconds.
   * @returns the disposer that restores the previous choice.
   */
  setHoverPeek(peek: SidebarHoverPeek): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The sidebar's arrangement, which a distribution sets. */
    sidebarLayout: SidebarLayout
  }
}

/** The section occupant receives the scroller hook from each render's hookContext. */
const SIDEBAR_SECTION_INJECT: SidebarSectionInjected = {
  hooks: { sectionScroller: (_standard, { useSectionScroller }) => useSectionScroller },
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar controls and global panel copy. */
    sidebar: SidebarKey
  }
}

/** The hover peek without a `setHoverPeek` call: on, after a 350 ms dwell. */
const DEFAULT_HOVER_PEEK: SidebarHoverPeek = { enabled: true, delayMs: 350 }

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

interface WorkspaceNavigation {
  startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
}

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar: dictionaries')
  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
  // Each call keeps its own entry, so disposing an earlier call never drops a later one.
  const placements: { readonly placement: SidebarPanelPlacement }[] = []
  const panelPlacement = createSnapshotStore<SidebarPanelPlacement>('top')
  const leads: SidebarLeadPanel[] = []
  const leadPanel = createSnapshotStore<SidebarLeadPanel | null>(null)
  const newSessionChoices: { readonly shown: boolean }[] = []
  const newSessionButton = createSnapshotStore(true)
  const footRowChoices: { readonly row: boolean }[] = []
  const footRow = createSnapshotStore(false)
  const hoverPeekChoices: { readonly peek: SidebarHoverPeek }[] = []
  const hoverPeek = createSnapshotStore<SidebarHoverPeek>(DEFAULT_HOVER_PEEK)
  ctx.provide('sidebarLayout', {
    setPanelPlacement: (placement) => {
      const entry = { placement }
      placements.push(entry)
      panelPlacement.set(placement)
      return () => {
        const index = placements.indexOf(entry)
        if (index === -1) return
        placements.splice(index, 1)
        panelPlacement.set(placements.at(-1)?.placement ?? 'top')
      }
    },
    setLeadPanel: (panelId, current) => {
      const entry: SidebarLeadPanel = current === undefined ? { panelId } : { panelId, current }
      leads.push(entry)
      leadPanel.set(entry)
      return () => {
        const index = leads.indexOf(entry)
        if (index === -1) return
        leads.splice(index, 1)
        leadPanel.set(leads.at(-1) ?? null)
      }
    },
    setNewSessionButton: (shown) => {
      const entry = { shown }
      newSessionChoices.push(entry)
      newSessionButton.set(shown)
      return () => {
        const index = newSessionChoices.indexOf(entry)
        if (index === -1) return
        newSessionChoices.splice(index, 1)
        newSessionButton.set(newSessionChoices.at(-1)?.shown ?? true)
      }
    },
    setFootRow: (row) => {
      const entry = { row }
      footRowChoices.push(entry)
      footRow.set(row)
      return () => {
        const index = footRowChoices.indexOf(entry)
        if (index === -1) return
        footRowChoices.splice(index, 1)
        footRow.set(footRowChoices.at(-1)?.row ?? false)
      }
    },
    setHoverPeek: (peek) => {
      const entry = { peek }
      hoverPeekChoices.push(entry)
      hoverPeek.set(peek)
      return () => {
        const index = hoverPeekChoices.indexOf(entry)
        if (index === -1) return
        hoverPeekChoices.splice(index, 1)
        hoverPeek.set(hoverPeekChoices.at(-1)?.peek ?? DEFAULT_HOVER_PEEK)
      }
    },
  } satisfies SidebarLayout)
  const syncPanels = (): void => {
    const next = ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => {
      // The list registration requires an id; StoredEntry erases the slot kind.
      const id = options.id as MainPanelId
      return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
    }).sort((a, b) => a.order - b.order)
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    panels.set(next)
  }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'ui-sidebar: panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')
  const panelPins = createPanelPins()
  const entryActions = {
    getSnapshot: () => ctx.slots.entriesOfSlot('sidebar.panellist.actions').length > 0,
    subscribe: (listener: () => void) => ctx.slots.subscribe('sidebar.panellist.actions', listener),
  }

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    setPinned: panelPins.setPinned,
    trackEntryClick: (attributes) => { ctx.get('productAnalytics')?.track('sidebar_menu_click', attributes) },
    hooks: {
      panels, shortcuts: ctx.shortcuts.catalog, entryPins: panelPins.unpinned, entryActions, panelPlacement, leadPanel, newSessionButton,
      footRow, hoverPeek,
    },
  })
  ctx.slots.inject('sidebar', function* () {
    yield ctx.slots.registerFactory({
      name: 'sidebar.panel.icon', scope: 'root',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    }, PanelIcon)
    yield ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.brand.badge': { kind: 'single', scope: 'root' },
        'sidebar.backdrop': { kind: 'single', scope: 'root' },
        'sidebar.toggle.badge': { kind: 'single', scope: 'root' },
        'sidebar.panellist.actions': { kind: 'list', scope: 'root' },
        'sidebar.sections': { kind: 'list', scope: 'root' },
        // The browsing region is the sidebar's one list of Workspaces and Sessions, and a distribution's own list is
        // a child seat of it, so a lower-priority occupant would replace that list rather than sit beside it. A plugin
        // that offers its own tree takes `sidebar.sections` instead.
        'sidebar.workspaces': {
          kind: 'single',
          scope: 'root',
          inject: SIDEBAR_SECTION_INJECT,
          reserved: {
            minPriority: 0,
            reason: 'the browsing region holds the Workspace and Session list and the lists registered into its child seats; register an additive section into "sidebar.sections" instead',
          },
        },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'sidebar.session.action': { kind: 'hoc', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot)
  })
  // macOS desktop hides the collapsed sidebar entirely, so the open/New
  // Session controls move into the frame's window-chrome seat beside the
  // traffic lights; the occupant reuses the shell's injected actions, and
  // the AppFrame mounts the seat only while the column is fully hidden.
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))
  syncPanels()
}
