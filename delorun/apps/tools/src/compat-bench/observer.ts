/**
 * The seam between the compatibility bench's runner and its privacy observers. The runner calls an {@link Observer}
 * around a run: `prepare` before the plugin container starts, `mark` before and after each stage, `finish` once the run
 * is over. The privacy lane implements observers in `compat-bench/privacy/`; the runner never reads what an observer
 * saw, except the {@link PrivacySection} it returns for the card.
 *
 * @module @delorun/tools/compat-bench/observer
 */

/** A run's facts an observer can read. */
export type RunContext = Readonly<{ host: 'delorun' | 'delorun-prev' | 'stock'; package: string; outDir: string; runId: string; baseline: boolean; studioPort?: number; container?: string }>

/** What an observer adds to the plugin container and its network. */
export type ContainerAdditions = Readonly<{ env?: Readonly<Record<string, string>>; files?: ReadonlyArray<Readonly<{ path: string; content: string; mode?: number }>>; networkContainer?: string; caCertPath?: string; preloads?: ReadonlyArray<string>; testChatMarker?: string }>

/** The stages of a run, in order. */
export type StageName = 'install' | 'start' | 'harness' | 'screens' | 'feature' | 'restart' | 'update' | 'clashes' | 'cost' | 'uninstall'

/** One privacy marker: what the observer saw, in plain words, with the evidence behind it. */
export type Marker = Readonly<{ state: 'not-seen' | 'seen' | 'declared' | 'not-checked'; summary: string; evidence: ReadonlyArray<string> }>

/** The card's privacy section: the eight markers and whether the observer could read the traffic's contents. */
export type MarkerKey = 'code' | 'chats' | 'modelKeys' | 'otherSecrets' | 'sendsOut' | 'actsForYou' | 'opensADoor' | 'leavesBehind'
export type PrivacySection = Readonly<{ markers: Readonly<Record<MarkerKey, Marker>>; contentsChecked: boolean; findings?: ReadonlyArray<string>; declared?: Readonly<Partial<Record<MarkerKey, string>>> }>

/** An observer the runner calls around a run. */
export type Observer = Readonly<{
  name: string
  prepare(ctx: RunContext): Promise<ContainerAdditions>
  mark(stage: StageName, phase: 'before' | 'after', ctx: RunContext): Promise<void>
  finish(ctx: RunContext): Promise<PrivacySection | undefined>
}>
