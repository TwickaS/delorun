/**
 * Delorun's real Changes and Setup versions sections and the real approval card, fed from a session's fixture in place
 * of the home's routes. Every action answers at once and changes nothing: what the visitor sees change is the next
 * fixture state the chapter script names. Their props are typed by the generated `studio/facade.d.ts`.
 * @module @delorun/website/replica/screens/real
 */
import type { ComponentProps, ComponentType } from 'react'
import { AllowForChat, ApprovalCard, ChangesSection, CommandText, VersionsSection } from 'virtual:replica-studio'
import { en as commonEn } from '#studio/locale/src/locales/en.ts'
import { en as approvalEn } from '#studio/ui-approval/src/client/locales.ts'
import { en as consentsEn } from '../../../../../packages/bundle-local/src/client/consents-locales.ts'
import { PROFILE_VERSION_ROUTES, type VersionChanges, type VersionsAnswer } from '../../../../../packages/bundle-local/src/client/versions-api.ts'
import { en as versionsEn } from '../../../../../packages/bundle-local/src/client/versions-locales.ts'
import { en as changesEn } from '../../../../../packages/plugin-changes/src/client/locales.ts'
import type { ChangesStateView } from '../../../../../packages/plugin-changes/src/wire.ts'
import type { ChangesGroup, SectionDictionaries } from '../model.ts'
import { translator } from '../strings.ts'
import type { PendingApproval } from './ChatScreen.tsx'

/** The real sections' dictionaries, for the presses the chapter script names by key. */
export const SECTION_DICTIONARIES: SectionDictionaries = { changes: changesEn, versions: versionsEn, approval: approvalEn }

/**
 * A section's translator: the product gives every plugin's dictionary the common one as well.
 * @param dictionary - the section's English dictionary.
 * @returns the translator.
 */
function sectionT<K extends string>(dictionary: Readonly<Record<K, string>>) {
  return translator<K | keyof typeof commonEn>({ ...commonEn, ...dictionary })
}

/** A tool call id as the approval card types it; the fixture is hand-made, so its plain string is branded here. */
type CardCallId = string & { readonly __brand: 'ToolCallId' }

/** The settings dialog's close, which the replica has no dialog for. */
const close = (): void => undefined

/** The slot runtime's standard props, which the real sections and card type but never read; the replica has no runtime. */
type RuntimeProps = 'SessionProvider' | 'useSession' | 'sessionId' | 'useProjection' | 'useAccess' | 'useConversation' | 'useInput'
  | 'inputActions' | 'useRemoteAccess' | 'useSessions' | 'useSessionStatus' | 'useSessionRetainInfo' | 'useSessionAccess' | 'usePanelInfo'
  | 'useContextMenu' | 'useWorkspaces' | 'useWorkspaceAccess' | 'renderFactorySlot' | 'useFactorySlot'

/**
 * A real component typed by the props it reads. `ChangesSection.tsx`, `VersionsSection.tsx` and `ApprovalCard.tsx` read
 * none of {@link RuntimeProps}; any other required prop they gain fails the type check here.
 * @param component - the real component.
 * @returns the same component, typed without the runtime's props.
 */
function own<P extends object>(component: ComponentType<P>): ComponentType<Omit<P, RuntimeProps>> {
  return component as ComponentType<Omit<P, RuntimeProps>>
}
const Changes = own(ChangesSection)
const Versions = own(VersionsSection)
const Card = own(ApprovalCard)

/** What the card hands its "Allow for this chat" slot; the generated facade prints the slot's owner as `object`. */
type ChoiceOwner = Omit<ComponentProps<typeof AllowForChat>, 't' | 'sessionId' | 'fetch' | 'consent' | 'currentPreset' | 'switchTo'>

/**
 * Whether a slot owner is the card's "Allow for this chat" owner.
 * @param owner - the owner the card passed.
 * @returns whether it carries the choice's callbacks.
 */
function isChoiceOwner(owner: object): owner is ChoiceOwner {
  return 'escalatesTo' in owner && 'allow' in owner && 'offer' in owner
}

const DONE = { kind: 'done' } as const
const settle = (): Promise<void> => Promise.resolve()

/**
 * A stylesheet that hides every group of the Changes section but the ones a chapter is about. The section names each
 * group by its heading, so the rule reads the same dictionary text.
 * @param groups - the groups to show.
 * @returns the rules.
 */
export function groupRules(groups: readonly ChangesGroup[]): string {
  const shown = groups.map(key => `[aria-label=${JSON.stringify(changesEn[key])}]`).join(',')
  return `[data-replica-changes] section[aria-label]${shown === '' ? '' : `:not(${shown})`}{display:none}`
}

/**
 * The real Changes section over one fixture state.
 * @param props - the state and the groups to show.
 * @returns the section.
 */
export function RealChanges({ state, groups }: { readonly state: ChangesStateView, readonly groups: readonly ChangesGroup[] }) {
  const load = { status: 'ready', state } as const
  return <div data-replica-changes="">
    <style>{groupRules(groups)}</style>
    <Changes
      t={sectionT(changesEn)}
      close={close}
      useChanges={select => select(load)}
      useRefusedRemote={select => select(false)}
      reload={settle}
      retry={settle}
      show={id => Promise.resolve({ kind: 'logged', entry: state.recent.find(entry => entry.id === id) ?? state.recent[0]! })}
      listPending={() => Promise.resolve([])}
      reviewWork={() => Promise.reject(new Error('The replica has no work session'))}
      apply={() => Promise.resolve(DONE)}
      applyRequest={() => Promise.resolve(DONE)}
      discard={() => Promise.resolve(DONE)}
      undo={() => Promise.resolve(DONE)}
      beginWork={() => Promise.resolve(DONE)}
      done={() => Promise.resolve(DONE)}
    />
  </div>
}

/**
 * The real Setup versions section over one fixture list.
 * @param props - the list and what switching to a version changes.
 * @returns the section.
 */
export function RealVersions({ versions, changes }: { readonly versions: VersionsAnswer, readonly changes: VersionChanges | undefined }) {
  const fetch = (input: string): Promise<Response> => {
    const body = input.startsWith(PROFILE_VERSION_ROUTES.changes) ? { changes } : versions
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  return <Versions t={sectionT(versionsEn)} close={close} fetch={fetch} atComputer={() => true} saveFile={() => undefined} />
}

/**
 * The real approval card for a pending approval, with the real "Allow for this chat" choice.
 * @param props - the approval.
 * @returns the card.
 */
export function RealApproval({ pending }: { readonly pending: PendingApproval }) {
  const approvalT = sectionT(approvalEn)
  const consentsT = sectionT(consentsEn)
  return <Card
    requestKey={pending.id}
    title={pending.reason}
    toolName={pending.toolName}
    callId={pending.callId as CardCallId}
    escalatesTo={pending.escalatesTo}
    t={approvalT}
    canAnswer={() => true}
    onAllow={settle}
    onReject={settle}
    renderSlot={(slot, owner) => slot === 'conversation.approval.choice' && isChoiceOwner(owner)
      ? <AllowForChat {...owner} t={consentsT} sessionId="replica" fetch={() => Promise.reject(new Error('The replica has no home'))}
        consent={{ ask: () => Promise.resolve(false), askSwitch: () => Promise.resolve(false) }}
        currentPreset={() => 'read-only'} switchTo={settle} />
      : slot === 'conversation.approval.detail' ? <CommandText text={pending.command} label={approvalT('detail.aria')} /> : null}
  />
}
