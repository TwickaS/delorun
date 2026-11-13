/**
 * The home process's registration of the secrets it holds with its log's redactor (contract C20, "Redaction", step 1),
 * and the attachment of the Host's Cordis logger to the same log.
 *
 * The Host's plugins find the registry as `ctx.deloSecrets` and register what they mint. This module registers the rest:
 * the secret-named values of the process environment, and every value the Host's credential provider returns, stores or
 * creates, including a key set later from the studio. A value that is rotated or removed is dropped.
 *
 * @module @delo/cli/log-secrets
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SecretKind, SecretSink } from '@delo/contract-operational-logs'
import type { HomeLog } from '@delo/home-process'
import { attachCordisLogs } from '@delo/logs/cordis'

/** Environment names whose values are secrets, by the words C20's structured-field step uses. */
const SECRET_NAME = /key|token|secret|password|passwd|cookie|credential/i

/**
 * Register the secret-named values of an environment.
 * @param env - the environment `delorun` was started with.
 * @param sink - where the values are registered.
 * @returns the disposer that drops them all.
 */
export function registerEnvironment(env: Readonly<Record<string, string | undefined>>, sink: SecretSink): () => void {
  const releases: (() => void)[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === '' || !SECRET_NAME.test(name)) continue
    releases.push(sink.register(value, /key/i.test(name) ? 'model-key' : 'session-secret'))
  }
  return () => { for (const release of releases) release() }
}

/**
 * The string values of a stored record, as the redactor holds them: a grant's payload fields and an environment
 * record's values.
 * @param record - the record.
 * @returns the values.
 */
function recordSecrets(record: CredentialRecord): readonly string[] {
  const values: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  visit(record.kind === 'grant' ? record.payload : [record.key, record.env])
  return values
}

/** What a watched credential provider keeps registered, by reference name or record key. */
class Held {
  private readonly values = new Map<string, { readonly values: readonly string[], readonly releases: readonly (() => void)[] }>()

  constructor(private readonly sink: SecretSink, private readonly kind: SecretKind) {}

  /**
   * Hold the current values of a reference or record, dropping the ones they replace.
   * @param name - the reference or record key.
   * @param values - its values; none once it has none.
   */
  set(name: string, values: readonly string[]): void {
    const held = this.values.get(name)
    if (held?.values.length === values.length && held.values.every((value, index) => value === values[index])) return
    for (const release of held?.releases ?? []) release()
    if (values.length === 0) this.values.delete(name)
    else this.values.set(name, { values, releases: values.map(value => this.sink.register(value, this.kind)) })
  }

  /** Drop every held value. */
  clear(): void {
    for (const { releases } of this.values.values()) for (const release of releases) release()
    this.values.clear()
  }
}

/**
 * Register what a credential provider hands out. The provider's `resolve`, `set`, `unset`, `readRecord` and
 * `modifyRecord` are wrapped on the instance while the Host runs, so a value is registered before the caller that asked
 * for it can log it, and a change made later from the studio or a phone is registered the same way.
 * @param provider - the Host's credential provider.
 * @param sink - where the values are registered.
 * @returns the disposer that restores the provider's methods and drops the values.
 */
export function watchCredentialProvider(provider: CredentialProvider, sink: SecretSink): () => void {
  const references = new Held(sink, 'model-key')
  const records = new Held(sink, 'session-secret')
  const original = { resolve: provider.resolve, set: provider.set, unset: provider.unset, readRecord: provider.readRecord, modifyRecord: provider.modifyRecord }
  const noteRecord = (key: string, record: CredentialRecord | undefined): void => {
    records.set(key, record === undefined ? [] : recordSecrets(record))
  }
  provider.resolve = async (ref: CredentialRef) => {
    const resolved = await original.resolve.call(provider, ref)
    references.set(ref, resolved === undefined ? [] : [resolved.value])
    return resolved
  }
  provider.set = async (ref: CredentialRef, value: string) => {
    references.set(ref, [value])
    await original.set.call(provider, ref, value)
  }
  provider.unset = async (ref: CredentialRef) => {
    await original.unset.call(provider, ref)
    references.set(ref, [])
  }
  provider.readRecord = async (key) => {
    const record = await original.readRecord.call(provider, key)
    noteRecord(key, record)
    return record
  }
  provider.modifyRecord = async (key, mutate) => original.modifyRecord.call(provider, key, async (current) => {
    const next = await mutate(current)
    const record = next ?? current
    // Registered before the write, so the value is held whether or not the write then succeeds.
    noteRecord(key, record)
    return next
  })
  return () => {
    Object.assign(provider, original)
    references.clear()
    records.clear()
  }
}

/**
 * Attach the Host's root context to the home log: the secret registry for the Host's plugins, the credential provider's
 * registrations, and the Host's Cordis logger messages as records keyed by session and turn. The shipped profile mounts
 * no console exporter, so a Cordis message reaches the log through this one path and not also as captured output.
 * @param root - the Host's root context, before its first entry mounts.
 * @param homeLog - the home process's log.
 */
export function attachHomeLogs(root: Context, homeLog: HomeLog): void {
  root.provide('deloSecrets', homeLog.redactor)
  root.effect(() => attachCordisLogs(root, homeLog.log), 'delo home log')
  root.inject(['credentials'], (ctx) => {
    ctx.effect(() => watchCredentialProvider(ctx.credentials, homeLog.redactor), 'delo credential registrations')
  })
}
