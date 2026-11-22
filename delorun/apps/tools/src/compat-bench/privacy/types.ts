/**
 * Shared types of the privacy observer: the marker names, the events the in-process hooks and the helper container
 * write, and the optional extras this lane adds to the runner's observer types (agreed with lane bench-core).
 *
 * @module @delorun/tools/compat-bench/privacy/types
 */
import type { ContainerAdditions, Marker, PrivacySection, RunContext } from '../observer.ts'

/** The eight markers of A587, in display order. */
export const MARKER_KEYS = ['code', 'chats', 'modelKeys', 'otherSecrets', 'sendsOut', 'actsForYou', 'opensADoor', 'leavesBehind'] as const
/** One marker's key. */
export type MarkerKey = (typeof MARKER_KEYS)[number]

/** The plain-English names of the markers, as the card shows them. */
export const MARKER_TITLES: Readonly<Record<MarkerKey, string>> = {
  code: 'Your code',
  chats: 'Your chats',
  modelKeys: 'Model keys',
  otherSecrets: 'Other secrets',
  sendsOut: 'Sends out',
  actsForYou: 'Acts for you',
  opensADoor: 'Opens a door',
  leavesBehind: 'Leaves behind',
}

/** The fixed line the card carries under the markers (A587). */
export const PRIVACY_FIXED_LINE = 'Plugins run with Delorun\'s full access. Markers show what it did, not what it could.'

/** The run facts the privacy observer reads beyond the interface's own: the agreed optional extras. */
export type PrivacyRunContext = RunContext & Readonly<{
  /** The studio ports the helper publishes on 127.0.0.1, because only the network owner can publish. */
  publish?: Readonly<{ host: number; container: number }>
}>

/** What the privacy observer adds to the plugin container, with the agreed extras. */
export type PrivacyAdditions = ContainerAdditions & Readonly<{
  /** The random word the runner puts in the one test chat message. */
  testChatMarker?: string
  /** A container whose process namespace the plugin container joins, so the helper can see its processes. */
  pidContainer?: string
}>

/** What the privacy section carries beyond the interface's own: seen but undeclared items and the declared reasons. */
export type PrivacyReport = PrivacySection & Readonly<{
  findings?: ReadonlyArray<string>
  declared?: Readonly<Partial<Record<MarkerKey, string>>>
}>

/** One event of the in-process hooks' log (`events.jsonl`), one JSON object per line. */
export type HookEvent =
  | Readonly<{ t: 'start'; pid: number; cmd: string }>
  | Readonly<{ t: 'connect'; pid: number; host: string; port: string; proto: 'tcp' | 'udp' }>
  | Readonly<{ t: 'connected'; pid: number; host: string; port: string; address: string }>
  | Readonly<{ t: 'listen'; pid: number; host: string; port: string }>
  | Readonly<{ t: 'exec'; pid: number; file: string; args: string }>
  | Readonly<{ t: 'env'; pid: number; name: string }>
  | Readonly<{ t: 'open'; pid: number; label: string; path: string }>

/** A connect or listen seen at the container level (the helper's socket poll or its proxy). */
export type NetEvent =
  | Readonly<{ t: 'connect'; host: string; port: string; name?: string }>
  | Readonly<{ t: 'listen'; host: string; port: string }>
  | Readonly<{ t: 'exec'; cmd: string }>

/** One host the proxy saw traffic to, and which canaries appeared in what it carried. */
export type ProxyHost = Readonly<{
  host: string
  port: string
  /** The canaries (by name) found in requests to this host. */
  canaries: ReadonlyArray<string>
  /** Where the first match was found, per canary: `url`, `header`, `body` or `tcp`. */
  where: Readonly<Record<string, string>>
  /** Requests carried (HTTP) or raw messages (TCP). */
  requests: number
  /** True when the TLS handshake failed, so the contents could not be read (pinned certificates). */
  pinned: boolean
}>

/** What the helper reports at the end of a run (`helper-report.json`). */
export type HelperReport = Readonly<{
  hosts: ReadonlyArray<ProxyHost>
  net: ReadonlyArray<NetEvent>
}>

/** What the observer found, before it is turned into markers: every list already has the baseline subtracted. */
export type Observed = Readonly<{
  connects: ReadonlyArray<{ host: string; port: string; name?: string }>
  listens: ReadonlyArray<{ host: string; port: string }>
  execs: ReadonlyArray<string>
  envNames: ReadonlyArray<string>
  envEnumerated: boolean
  opens: ReadonlyArray<{ label: string; path: string }>
  /** Files that exist now and did not exist in the baseline's container (from `docker diff`), with their change kind. */
  fileChanges: ReadonlyArray<{ kind: 'A' | 'C' | 'D'; path: string }>
  /** The canaries found anywhere in the filesystem after uninstall, by name, with the paths. */
  leftCanaries: ReadonlyArray<{ canary: string; path: string }>
  proxy: ReadonlyArray<ProxyHost>
  /** What differs between the request the mock model received in this run and in the baseline; empty when it matches. */
  requestChanges: ReadonlyArray<string>
  /** Whether the run could read the contents of encrypted traffic. */
  contentsChecked: boolean
}>

/** The result of a marker's decision, before declared access is applied. */
export type RawMarker = Readonly<{ seen: boolean; notChecked?: boolean; summary: string; evidence: ReadonlyArray<string> }>

export type { Marker }
