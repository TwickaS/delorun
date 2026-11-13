/**
 * The approved-plugin write consent of `@delo/plugin-instruction-consent` (C16 switch `approved_plugin_write_consent`):
 * with protection on, before the agent's first write in a chat to the `source` folder of a plugin the person approved
 * under Changes, the person is asked, and the ask names the plugin and says the agent is changing what the harness
 * runs. With protection off, the default, such a write does not ask: the plugin's folder loads without review anyway.
 * The protection setting and the approvals are read from the home and the profile the Host runs at every write, so
 * `delorun changes protection on|off` and a plugin approved while the Host runs take effect at once, and a profile
 * without the record has none. A protection record or an approval record that cannot be read refuses the write. A write
 * into the profile's active directories under the Delo home, which only Changes writes, is refused without asking in
 * either setting.
 *
 * A target is compared on the path the file backend writes, `target.targetKey`: the local backends key a target by its
 * real path, its own when it exists, otherwise its deepest existing ancestor's with the rest appended, so a symbolic
 * link, a `..` spelling or a case variant names the file it writes. A folder's real path is computed the same way. The
 * target is inside a folder when that path, or the target's lexical path, is the folder or lies below it; when the
 * folder's volume ignores case, which a probe of the folder's own path in another case decides, the comparison ignores
 * case too; and when an existing ancestor of the target is the folder's directory itself (the same device and inode),
 * however it is spelt.
 *
 * The ask is kept per chat and plugin for the Host process's lifetime: after the person allows it, later writes to
 * that plugin's folder in the same chat pass; another chat, or the same chat after the Host restarts, asks again. A
 * refusal leaves the file unchanged and asks again at the next write. With protection on the writes still appear in
 * Changes as pending changes, which only the person applies.
 *
 * @module @delo/plugin-instruction-consent/plugin-folders
 */
import type { BigIntStats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { WriteConsentRefusedError, type WriteConsentArgs, type WriteConsentDiff } from '@deepseek-ai/dsh-tool-fs/src/consent.ts'
import { CHANGES_ENTRIES, profileChangesDirectory, readApproved, readProtection, type ProtectionLevel } from '@delo/changes'
import { diffText } from './classify.ts'

/** One approved plugin and the folder whose files are its content. */
export interface PluginFolders {
  /** The package name. */
  readonly plugin: string
  /** Its `source` folder, absolute. */
  readonly source: string
}

/** The profile the Host runs, as the consent reads it. */
export interface ConsentProfile {
  /** The Delo home. */
  readonly home: string
  /** The profile's name. */
  readonly name: string
  /** The profile's directory. */
  readonly dir: string
}

/**
 * The `source` folder of every plugin the profile approved.
 * @param profile - the profile the Host runs.
 * @returns one entry per approved plugin; none when the profile's manifest holds no approval record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the profile's `package.json` or its record cannot be read.
 */
export async function approvedPluginFolders(profile: ConsentProfile): Promise<PluginFolders[]> {
  const record = await readApproved(profile.dir)
  return Object.entries(record.plugins).map(([plugin, approval]) => ({ plugin, source: resolve(approval.source) }))
}

/**
 * The directory that holds the profile's active directories, one per plugin under Changes.
 * @param profile - the profile the Host runs.
 * @returns `changes/profiles/<profile>/active` under the Delo home.
 */
export function activeRoot(profile: ConsentProfile): string {
  return join(profileChangesDirectory(profile.home, profile.name), CHANGES_ENTRIES.active)
}

/**
 * The real path of a path as the local file backends key a write target: its own when it exists, otherwise its deepest
 * existing ancestor's with the rest appended.
 * @param path - an absolute path.
 * @returns the real path, and the deepest part of it that exists.
 */
async function realPathOf(path: string): Promise<{ readonly real: string, readonly existing: string }> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      const existing = await realpath(current)
      return { real: join(existing, ...missing), existing }
    } catch {
      // ENOENT, ENOTDIR, ELOOP or EACCES: this part of the path does not resolve, so its parent is tried, as the
      // backends do for a target that does not exist yet.
    }
    const parent = dirname(current)
    /* v8 ignore next -- the filesystem root always resolves, so the walk ends at the latest there */
    if (parent === current) return { real: path, existing: path }
    missing.unshift(basename(current))
    current = parent
  }
}

/**
 * @param path - a path.
 * @returns its status, or undefined when it does not resolve.
 */
async function statOf(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true })
  } catch {
    // ENOENT, ENOTDIR, ELOOP or EACCES: the path names no file this process can reach.
    return undefined
  }
}

/**
 * @param left - a file's status.
 * @param right - another file's status.
 * @returns whether both name the same file.
 */
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Whether lookups on an existing path's volume ignore case: the path with its last name that has cased letters spelt in
 * the other case names the same file. A path with no cased letter counts as case-sensitive.
 * @param existing - an existing real path.
 * @returns whether case is ignored there.
 */
async function ignoresCase(existing: string): Promise<boolean> {
  const names = existing.split(sep)
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index]!
    const other = [...name].map(letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()).join('')
    if (other === name) continue
    const spelt = names.slice(0, index + 1).join(sep)
    const [own, variant] = await Promise.all([statOf(spelt), statOf([...names.slice(0, index), other].join(sep))])
    return own !== undefined && variant !== undefined && sameFile(own, variant)
  }
  return false
}

/**
 * @param directory - an absolute directory.
 * @param path - an absolute path.
 * @param fold - whether case is ignored.
 * @returns whether the path is the directory or lies inside it.
 */
function inside(directory: string, path: string, fold: boolean): boolean {
  const [base, candidate] = fold ? [directory.toLowerCase(), path.toLowerCase()] : [directory, path]
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

/**
 * Whether a write target lands in a folder.
 * @param target - the target the file tool resolved; its `targetKey` is the real path the local backends write.
 * @param folder - an absolute folder.
 * @returns whether the target is the folder or lies inside it, however either is spelt.
 */
export async function lands(target: FsTarget, folder: string): Promise<boolean> {
  const written = String(target.targetKey)
  const paths = [written, resolve(target.displayPath)]
  const { real, existing } = await realPathOf(folder)
  const fold = await ignoresCase(existing)
  if ([folder, real].some(root => paths.some(path => inside(root, path, fold)))) return true
  const root = await statOf(real)
  if (root === undefined) return false
  for (let current = written; ; current = dirname(current)) {
    const status = await statOf(current)
    if (status !== undefined && sameFile(status, root)) return true
    if (dirname(current) === current) return false
  }
}

/**
 * The approved plugin a write target belongs to.
 * @param target - the target the file tool resolved.
 * @param plugins - the approved plugins' folders.
 * @returns the plugin's package name, or undefined when the target is in none of their folders.
 */
export async function pluginOfTarget(target: FsTarget, plugins: readonly PluginFolders[]): Promise<string | undefined> {
  for (const { plugin, source } of plugins) {
    if (await lands(target, source)) return plugin
  }
  return undefined
}

/**
 * The diff one mutating call carries, from the tool's own arguments, as the instruction-layer asks show it.
 * @param tool - the tool's name.
 * @param args - its arguments.
 * @returns the diff, or undefined when the tool carries none.
 */
export function callDiff(tool: string, args: WriteConsentArgs): WriteConsentDiff | undefined {
  const text = (value: unknown): string => typeof value === 'string' ? value : ''
  if (tool === 'write') return { old: null, new: text(args.content) }
  if (tool === 'edit') return { old: text(args.old_string), new: text(args.new_string) }
  if (tool === 'apply_patch') return typeof args.input === 'string' ? args.input : undefined
  if (tool === 'str_replace_editor') return typeof args.file_text === 'string' ? { old: null, new: args.file_text } : { old: text(args.old_str), new: text(args.new_str) }
  return undefined
}

/**
 * The ask's text: the plugin, the effect and the diff, in English and Chinese.
 * @param plugin - the plugin's package name.
 * @param diff - the call's diff.
 * @returns the English text, which the approval records, and the localized display text.
 */
export function pluginWriteAsk(plugin: string, diff: WriteConsentDiff | undefined): { readonly en: string, readonly zh: string } {
  const body = diffText(diff)
  return {
    en: `The agent is changing what your harness runs: ${plugin}. The change will wait for your review in Changes. The diff, verbatim:\n${body}`,
    zh: `智能体正在更改你的 harness 运行的内容：${plugin}。这项更改会在“更改”中等待你的审查。差异原文：\n${body}`,
  }
}

/**
 * With protection on, ask before the first write in a chat to an approved plugin's folder; in either protection
 * setting, refuse any write into the profile's active directories. The listeners are prepended to the three intent waterfalls every filesystem writer emits once per
 * target, so each target of a patch is reviewed and a policy that decides without calling `next()` cannot skip them.
 * @param ctx - the plugin context, whose `profileContext` and `approval` services are read at each write.
 */
export function askBeforePluginWrites(ctx: Context): void {
  /** The plugins each chat's person allowed writes to, by session id. */
  const allowed = new Map<string, Set<string>>()

  /**
   * Review one intent.
   * @param target - the resolved target.
   * @param actor - the tool execution that emitted the intent.
   * @throws WriteConsentRefusedError when the target is inside the profile's active directories, the ask is refused,
   *   cancelled or cannot be put, or the protection setting or the profile's record of approved plugins cannot be read.
   */
  const review = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    const profile = ctx.get('profileContext')
    if (actor === undefined || profile === undefined) return
    const exec = actor as ToolExecution
    if (await lands(target, activeRoot(profile))) {
      throw new WriteConsentRefusedError(`the ${exec.name} to "${target.displayPath}" was not run: it is inside the directory Changes loads the harness's plugins from, which only Changes writes, so the write would never become the person's plugin; change the plugin's own folder instead, and the person reviews that change in Changes`)
    }
    let level: ProtectionLevel
    try {
      level = await readProtection(profile.home)
    } catch (error) {
      // readProtection rejects with a ChangesError, whose message names the file and what is wrong with it.
      throw new WriteConsentRefusedError(`the ${exec.name} to "${target.displayPath}" was not run: the protection setting, which decides whether a write to an approved plugin's folder asks first, cannot be read (${(error as Error).message})`, { cause: error })
    }
    if (level === 'off') return
    let plugins: PluginFolders[]
    try {
      plugins = await approvedPluginFolders(profile)
    } catch (error) {
      // readApproved rejects with a ChangesError, whose message names the file and what is wrong with it.
      throw new WriteConsentRefusedError(`the ${exec.name} to "${target.displayPath}" was not run: the profile's record of approved plugins cannot be read (${(error as Error).message})`, { cause: error })
    }
    const plugin = await pluginOfTarget(target, plugins)
    if (plugin === undefined) return
    const path = target.displayPath
    const agent = exec.agent
    if (agent === undefined) throw new WriteConsentRefusedError(`the ${exec.name} to "${path}" changes the plugin ${plugin} and requires approval, but the call has no agent to route it through`)
    const session = String(agent.session.id)
    if (allowed.get(session)?.has(plugin) === true) return
    const approver = ctx.get('approval')
    if (approver === undefined) throw new WriteConsentRefusedError(`the ${exec.name} to "${path}" changes the plugin ${plugin} and requires approval, but no approval service is composed`)
    const ask = pluginWriteAsk(plugin, callDiff(exec.name, (exec.arguments ?? {}) as WriteConsentArgs))
    const outcome = await approver.request({
      agent,
      toolName: exec.name,
      ...exec.callId !== undefined ? { callId: exec.callId } : {},
      reason: ask.en,
      displayReason: ask,
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once':
        allowed.set(session, (allowed.get(session) ?? new Set()).add(plugin))
        return
      case 'rejected': throw new WriteConsentRefusedError(`the user refused the ${exec.name} to "${path}", which changes the plugin ${plugin}; it stays unchanged, so stop and explain instead of working around it`)
      case 'cancelled': throw new WriteConsentRefusedError(`approval for the ${exec.name} to "${path}", which changes the plugin ${plugin}, was cancelled`)
      case 'unavailable': throw new WriteConsentRefusedError(`the ${exec.name} to "${path}" changes the plugin ${plugin} and requires approval, but no approval channel is available`)
    }
  }

  /**
   * One intent's listener: review, then continue the waterfall.
   * @param target - the resolved target.
   * @param actor - the tool execution that emitted the intent.
   * @param next - the waterfall's default decision.
   * @returns the decision the waterfall continues with.
   */
  const gate = async <T>(target: FsTarget, actor: object | undefined, next: () => T | Promise<T>): Promise<T> => {
    await review(target, actor)
    return await next()
  }
  ctx.on('fs/write-intent', gate, true)
  ctx.on('fs/edit-intent', gate, true)
  ctx.on('fs/delete-intent', gate, true)
}
