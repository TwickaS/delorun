/**
 * The account service behind `ctx.agentAccounts`: it reads each provider's stored figures, folds in what runs and
 * limits checks observe, and starts a limits check through the start gate when one is due.
 *
 * A check is a short-lived start of the provider's own program with no task. It runs only when {@link
 * AgentAccountsService.refresh} is called: once when a provider's driver registers (its pack was added), after a
 * sign-in, and on "Check now". Reading never starts one. Checks are throttled to one per provider per
 * `probeMinIntervalMinutes`, counted from the last check that answered or failed, as the store records it, so a
 * restart does not check again; `signed-in` skips the throttle, because the figures it brings are new. One check per
 * provider runs at a time: a refresh while one runs waits for it and answers with its outcome.
 *
 * Observations are best effort: a write that fails is reported through `report` and the figures stay as they were.
 * Free of Cordis, so it is testable with a fake gate and a fake clock.
 *
 * @module @delorun/external-agents/accounts/service
 */
import type { AccountObservation, ExternalAgentName } from '../contract.ts'
import { reachedLimit, type ReachedLimit } from './limit.ts'
import { EMPTY_ACCOUNTS, mergeObservation, problemOf, readAccountsFile, sanitiseObservation, UNKNOWN_ACCOUNT, writeAccountsFile } from './store.ts'
import { ACCOUNT_PROVIDERS, type AccountsAnswer, type AccountsFile, type AccountState, type AccountView, type RefreshAnswer, type RefreshOutcome } from './wire.ts'

/** Why a check is asked for. `signed-in` skips the throttle; the others honour it. */
export type RefreshReason = 'pack-added' | 'signed-in' | 'check-now'

/** What the start gate answered a limits check. */
export type CheckResult =
  | { readonly kind: 'observed'; readonly observation: AccountObservation }
  | { readonly kind: 'failed'; readonly problem: string }
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'refused'; readonly problem: string }

/** What the service runs against. */
export interface AgentAccountsDependencies {
  /** The accounts file's absolute path. */
  readonly storePath: string
  /**
   * The current time.
   * @returns milliseconds since the epoch.
   */
  readonly now: () => number
  /**
   * The shortest time between two checks of one provider, read at each refresh so a saved change applies at once.
   * @returns milliseconds.
   */
  readonly probeMinIntervalMs: () => number
  /**
   * Whether a provider's pack is added, so its driver is registered.
   * @param provider - the provider.
   * @returns whether a check can start.
   */
  readonly installed: (provider: ExternalAgentName) => boolean
  /**
   * Start a limits check through the start gate (`purpose: 'probe'`) and wait for its answer.
   * @param provider - the provider.
   * @param signal - aborts when the service is disposed.
   * @returns what the check found, or why it did not run.
   */
  readonly check: (provider: ExternalAgentName, signal: AbortSignal) => Promise<CheckResult>
  /**
   * Report a failure nobody waits for, such as a write of observed figures.
   * @param message - what failed, with no figures and no program output.
   */
  readonly report: (message: string) => void
  /** Aborts when the service is disposed; checks in progress are aborted with it. */
  readonly signal: AbortSignal
}

/** The service `ctx.agentAccounts` provides. */
export interface AgentAccountsService {
  /**
   * One provider's figures. Never starts a check.
   * @param provider - the provider.
   * @returns its stored figures, unknown when none are stored or the file cannot be read.
   */
  read(provider: ExternalAgentName): Promise<AccountView>
  /**
   * Every provider's figures. Never starts a check.
   * @returns the figures in provider order, with the time they were read at.
   */
  readAll(): Promise<AccountsAnswer>
  /**
   * Fold in what a run or a check saw. Only the fields the store may hold are kept.
   * @param observation - the observation.
   * @returns once it is written, or the write failed and was reported.
   */
  observe(observation: AccountObservation): Promise<void>
  /**
   * Check a provider's figures now, unless its pack is missing or the last check was too recent.
   * @param provider - the provider.
   * @param reason - why the check is asked for.
   * @returns what the refresh did and the figures after it.
   */
  refresh(provider: ExternalAgentName, reason: RefreshReason): Promise<RefreshAnswer>
  /**
   * Check a provider once its driver registers, in the background; a failure is reported.
   * @param provider - the provider whose driver registered.
   */
  driverAdded(provider: ExternalAgentName): void
  /**
   * The reached limit that refuses a start of a provider now, from its stored figures.
   * @param provider - the provider.
   * @returns the limit, or undefined when nothing refuses.
   */
  limitReached(provider: ExternalAgentName): Promise<ReachedLimit | undefined>
}

/**
 * Build the service.
 * @param dependencies - what it runs against.
 * @returns the service.
 */
export function createAgentAccounts(dependencies: AgentAccountsDependencies): AgentAccountsService {
  const { storePath, now, report } = dependencies
  const running = new Map<ExternalAgentName, Promise<RefreshAnswer>>()
  let writes: Promise<void> = Promise.resolve()

  /** @returns the stored accounts, or none when the file cannot be read. */
  const load = async (): Promise<AccountsFile> => {
    const read = await readAccountsFile(storePath)
    return read.kind === 'readable' ? read.file : EMPTY_ACCOUNTS
  }

  /**
   * Change one provider's stored account, after every earlier change.
   * @param provider - the provider.
   * @param change - the account to store, from the stored one.
   * @returns once written; rejects with the write's failure.
   */
  const change = (provider: ExternalAgentName, change: (account: AccountState | undefined) => AccountState): Promise<void> => {
    const next = writes.then(async () => {
      const file = await load()
      await writeAccountsFile(storePath, { v: file.v, accounts: { ...file.accounts, [provider]: change(file.accounts[provider]) } })
    })
    writes = next.catch((_failed: unknown) => {
      // The failure reaches the caller through `next`; later changes still run.
    })
    return next
  }

  /**
   * @param provider - the provider.
   * @param account - its stored figures.
   * @returns the provider's view.
   */
  const view = (provider: ExternalAgentName, account: AccountState | undefined): AccountView =>
    ({ provider, installed: dependencies.installed(provider), ...(account ?? UNKNOWN_ACCOUNT) })

  const read = async (provider: ExternalAgentName): Promise<AccountView> => view(provider, (await load()).accounts[provider])

  const observe = async (observation: AccountObservation): Promise<void> => {
    const sanitised = sanitiseObservation(observation)
    const at = now()
    try {
      await change(sanitised.provider, account => mergeObservation(account, sanitised, at))
    } catch (error) {
      report(`the ${sanitised.provider} limit figures could not be saved (${problemOf(error)})`)
    }
  }

  /**
   * Run one check and record its outcome.
   * @param provider - the provider.
   * @returns the outcome.
   */
  const run = async (provider: ExternalAgentName): Promise<RefreshOutcome> => {
    let result: CheckResult
    try {
      result = await dependencies.check(provider, dependencies.signal)
    } catch (error) {
      result = { kind: 'failed', problem: problemOf(error) }
    }
    switch (result.kind) {
      case 'observed':
        await observe({ ...result.observation, provider, source: 'probe' })
        return { kind: 'checked' }
      case 'failed': {
        const at = now()
        await change(provider, account => ({ ...(account ?? UNKNOWN_ACCOUNT), checkFailedAt: at })).catch((error: unknown) => {
          report(`the ${provider} limits check time could not be saved (${problemOf(error)})`)
        })
        return { kind: 'failed', problem: result.problem }
      }
      case 'not-installed':
        return { kind: 'not-installed' }
      case 'refused':
        return { kind: 'refused', problem: result.problem }
    }
  }

  /**
   * @param provider - the provider.
   * @param reason - why.
   * @returns the refresh's answer.
   */
  const start = async (provider: ExternalAgentName, reason: RefreshReason): Promise<RefreshAnswer> => {
    if (!dependencies.installed(provider)) return { outcome: { kind: 'not-installed' }, account: await read(provider), now: now() }
    if (reason !== 'signed-in') {
      const stored = (await load()).accounts[provider]
      const last = Math.max(stored?.checkedAt ?? 0, stored?.checkFailedAt ?? 0)
      const nextAt = last + dependencies.probeMinIntervalMs()
      if (last > 0 && nextAt > now()) return { outcome: { kind: 'throttled', nextAt }, account: view(provider, stored), now: now() }
    }
    const outcome = await run(provider)
    return { outcome, account: await read(provider), now: now() }
  }

  const refresh = (provider: ExternalAgentName, reason: RefreshReason): Promise<RefreshAnswer> => {
    const current = running.get(provider)
    if (current !== undefined) return current
    const answer = start(provider, reason).finally(() => { running.delete(provider) })
    running.set(provider, answer)
    return answer
  }

  return {
    read,
    readAll: async () => {
      const file = await load()
      return { accounts: ACCOUNT_PROVIDERS.map(provider => view(provider, file.accounts[provider])), now: now() }
    },
    observe,
    refresh,
    driverAdded: (provider) => {
      refresh(provider, 'pack-added').catch((error: unknown) => {
        report(`the ${provider} limits check after its pack was added failed (${problemOf(error)})`)
      })
    },
    limitReached: async provider => reachedLimit((await load()).accounts[provider], now()),
  }
}
