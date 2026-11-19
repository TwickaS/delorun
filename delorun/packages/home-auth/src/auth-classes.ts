/**
 * `AUTH_CLASSES`: the one table that says how every action a paired device could take is authenticated (Face ID plan,
 * Extension 2, A1). Each row names one thing and sits in exactly one class:
 *
 * - `free`: any approved device, no prompt;
 * - `face`: one Face ID (or one PIN, as a one-action grant) at the moment of the action; the home keeps the grant
 *   ({@link GrantStore}) and the gate uses it up ({@link gateByClass}, the reach policy's condition, `checkAnswer`);
 * - `computer`: only the person at the computer;
 * - `ticket`: a device route that works only with a single-use enrolment ticket the computer's approval minted, or that
 *   only shows a code the person types at the computer. No gate admits it by class; the route checks its own ticket.
 *
 * The rows of the Remote methods are listed here from the tables of `./reach-access.ts`; the rows of the plugin Fetch
 * routes and of Changes come from `./route-access.ts`, which lane C maps route by route. {@link checkAuthTable} is the
 * gate `tests/auth-classes.spec.ts` runs: a row in two classes, a duplicate id, a row without a reason and a registered
 * action or route with no row all fail it.
 *
 * @module @delorun/home-auth/auth-classes
 */
import { holdFeatureOf, type HoldFeature } from './grants.ts'
import {
  REACH_ALLOWED_ACTIONS, REACH_DANGEROUS_ACTIONS, REACH_DENIED_ACTIONS, REACH_ELEVATED_ACTIONS, REACH_KEY_ACTIONS,
} from './reach-access.ts'
import { CHANGES_ROUTE_ACCESS, COMPUTER_ONLY, PLUGIN_ROUTE_ACCESS, type RouteAccess, type RouteLevel } from './route-access.ts'

/** The four classes. */
export const AUTH_CLASS_NAMES = ['free', 'face', 'computer', 'ticket'] as const

/** One of {@link AUTH_CLASS_NAMES}. */
export type AuthClass = (typeof AUTH_CLASS_NAMES)[number]

/** What kind of thing a row names; it is the prefix of the row's id. */
export type AuthSurface = 'remote' | 'route' | 'changes' | 'answer' | 'auth' | 'computer'

/** One thing and how it is authenticated. */
export interface AuthRow {
  /** `<surface>:<name>`, unique in the table. */
  readonly id: string
  readonly surface: AuthSurface
  readonly authClass: AuthClass
  /** Why it is in that class, in the words the denial specs and the docs use. */
  readonly reason: string
  /** For a `face` row that opens a stream or a picker: the feature whose hold the grant may open. */
  readonly hold?: HoldFeature
}

/**
 * @param surface - the surface of every row.
 * @param authClass - the class of every row.
 * @param table - action names with their reasons.
 * @param prefix - what each id begins with.
 * @returns one row per entry.
 */
function rowsOf(surface: AuthSurface, authClass: AuthClass, table: Readonly<Record<string, string>>, prefix: string): AuthRow[] {
  return Object.entries(table).map(([name, reason]): AuthRow => {
    const hold = surface === 'remote' && authClass === 'face' ? holdFeatureOf(name) : undefined
    return { id: `${prefix}${name}`, surface, authClass, reason, ...hold === undefined ? {} : { hold } }
  })
}

/** The class of a key action: saving and removing a provider key is Face ID; reading presence and the events are free. */
const KEY_FACE: ReadonlySet<string> = new Set(['credentials/set', 'credentials/unset'])

/** The Remote method and event rows. */
const REMOTE_ROWS: readonly AuthRow[] = [
  ...rowsOf('remote', 'free', REACH_ALLOWED_ACTIONS, 'remote:'),
  ...Object.entries(REACH_KEY_ACTIONS).map(([name, reason]): AuthRow => ({ id: `remote:${name}`, surface: 'remote', authClass: KEY_FACE.has(name) ? 'face' : 'free', reason })),
  ...rowsOf('remote', 'face', REACH_ELEVATED_ACTIONS, 'remote:'),
  ...rowsOf('remote', 'computer', REACH_DENIED_ACTIONS, 'remote:'),
  ...rowsOf('remote', 'computer', REACH_DANGEROUS_ACTIONS, 'remote:'),
  { id: 'remote:session/create outside the known workspaces', surface: 'remote', authClass: 'face', reason: 'a folder outside the known workspaces decides where the chat\'s commands may write' },
  { id: 'remote:workspaceFiles/* outside the workspace', surface: 'remote', authClass: 'face', reason: 'a path outside a chat\'s workspace, though never in the Delorun home, is reachable only with a grant for that call' },
  { id: 'remote:commands/execute of an unlisted command', surface: 'remote', authClass: 'face', reason: 'a slash command a device does not run by default can change settings, plugins or the profile' },
  { id: 'remote:settings write that loosens the default preset', surface: 'remote', authClass: 'face', reason: 'the permission new chats start in is the same trust as full access; protected rows and computer-only switches stay at the computer' },
]

/** How a legacy plugin route level maps to its classes; `R+U` is both, by route. */
const LEGACY_CLASS: Readonly<Record<RouteLevel, readonly AuthClass[]>> = { R: ['free'], U: ['face'], C: ['computer'], K: ['free'], 'R+U': ['free', 'face'] }

/**
 * @param surface - `route` or `changes`.
 * @param name - the part of the id after the prefix.
 * @param access - the route's legacy level and reason.
 * @returns one row, or two for a registration that serves both a read and a write.
 */
function legacyRows(surface: 'route' | 'changes', name: string, access: RouteAccess): AuthRow[] {
  const classes = LEGACY_CLASS[access.level]
  const [only] = classes
  if (classes.length === 1 && only !== undefined) return [{ id: `${surface}:${name}`, surface, authClass: only, reason: access.reason }]
  return classes.map((authClass): AuthRow => ({ id: `${surface}:${name} (${authClass === 'free' ? 'read' : 'write'})`, surface, authClass, reason: access.reason }))
}

/** The plugin Fetch route rows and the Changes rows, which lane C maps to their final classes. */
const ROUTE_ROWS: readonly AuthRow[] = [
  ...Object.entries(PLUGIN_ROUTE_ACCESS).flatMap(([file, routes]) => Object.entries(routes).flatMap(([expression, access]) => legacyRows('route', `${file}#${expression}`, access))),
  ...Object.entries(CHANGES_ROUTE_ACCESS).flatMap(([name, access]) => legacyRows('changes', name, access)),
]

/** The prompts a device answers: each grants something the home's computer keeps, and a device answers one with a grant bound to the prompt and the answer. */
const ANSWER_ROWS: readonly AuthRow[] = [
  { id: 'answer:full-access', surface: 'answer', authClass: 'face', reason: 'escalating to danger-full-access, or a workspace\'s full-access consent, widens what a chat may write' },
  { id: 'answer:workspace-management', surface: 'answer', authClass: 'face', reason: 'creating, cloning, trashing or restoring a workspace, an instruction-layer file, the main chat\'s commands and writes' },
  { id: 'answer:external-agent', surface: 'answer', authClass: 'face', reason: 'starting an external agent program outside the sandbox' },
  { id: 'answer:real-browser', surface: 'answer', authClass: 'face', reason: 'letting the agent use the person\'s own browser, with their sign-ins, in this chat' },
]

/** The `/auth/passkey/*` routes. */
const PASSKEY_ROWS: readonly AuthRow[] = [
  { id: 'auth:/auth/passkey/state', surface: 'auth', authClass: 'free', reason: 'a device reads its own passkeys and whether a ticket waits' },
  { id: 'auth:/auth/passkey/register/options', surface: 'auth', authClass: 'ticket', reason: 'enrolment needs the single-use ticket the computer\'s approval minted, so the root of the factor is the computer\'s decision' },
  { id: 'auth:/auth/passkey/register', surface: 'auth', authClass: 'ticket', reason: 'enrolment needs the single-use ticket the computer\'s approval minted, so the root of the factor is the computer\'s decision' },
  { id: 'auth:/auth/passkey/add/request', surface: 'auth', authClass: 'ticket', reason: 'the device only shows a code; the person types it at the computer' },
  { id: 'auth:/auth/passkey/add/pending', surface: 'auth', authClass: 'computer', reason: 'lists the requests the person at the computer may approve' },
  { id: 'auth:/auth/passkey/add/approve', surface: 'auth', authClass: 'computer', reason: 'adding a passkey is approved by a code typed at the computer' },
  { id: 'auth:/auth/passkey/options', surface: 'auth', authClass: 'free', reason: 'asks for a challenge; nothing happens until an assertion verifies' },
  { id: 'auth:/auth/passkey/verify', surface: 'auth', authClass: 'free', reason: 'a failed assertion counts as a wrong try; a passed one mints a one-action grant' },
  { id: 'auth:/auth/passkey/pin', surface: 'auth', authClass: 'free', reason: 'a correct PIN mints a one-action grant; wrong tries count as an unlock does' },
  { id: 'auth:/auth/passkey/devices', surface: 'auth', authClass: 'face', reason: 'it reads the device list and each device\'s passkeys, which is device metadata' },
  { id: 'auth:/auth/devices/remove', surface: 'auth', authClass: 'face', reason: 'a device removes another device only with a grant for exactly that removal, while Face ID is on; removing itself needs none' },
  { id: 'auth:/auth/passkey/remove', surface: 'auth', authClass: 'face', reason: 'a device removes its own or another device\'s passkey only with a grant for exactly that removal' },
]

/** The things that stay at the computer, from `COMPUTER_ONLY` in `./route-access.ts`. */
const COMPUTER_ROWS: readonly AuthRow[] = COMPUTER_ONLY.map((row): AuthRow => ({ id: `computer:${row.kind}:${row.id}`, surface: 'computer', authClass: 'computer', reason: row.reason }))

/** Every row. */
export const AUTH_CLASSES: readonly AuthRow[] = [...REMOTE_ROWS, ...ROUTE_ROWS, ...ANSWER_ROWS, ...PASSKEY_ROWS, ...COMPUTER_ROWS]

/**
 * The class of a row.
 * @param id - the row's id.
 * @returns the class, or undefined for an id no row names.
 */
export function authClassOf(id: string): AuthClass | undefined {
  return AUTH_CLASSES.find(row => row.id === id)?.authClass
}

/**
 * The problems of an auth table: an id listed twice (in the same class or in two), a row with no reason or an unknown
 * class or surface.
 * @param rows - the table to check; {@link AUTH_CLASSES} in production.
 * @returns one sentence per problem, empty for a sound table.
 */
export function checkAuthTable(rows: readonly AuthRow[]): readonly string[] {
  const problems: string[] = []
  const seen = new Map<string, AuthClass>()
  for (const row of rows) {
    const first = seen.get(row.id)
    if (first !== undefined) problems.push(first === row.authClass ? `${row.id} is listed twice` : `${row.id} is in two classes (${first}, ${row.authClass})`)
    else seen.set(row.id, row.authClass)
    if (row.reason.trim() === '') problems.push(`${row.id} has no reason`)
    if (!AUTH_CLASS_NAMES.some(name => name === row.authClass)) problems.push(`${row.id} has the unknown class ${row.authClass}`)
  }
  return problems
}
