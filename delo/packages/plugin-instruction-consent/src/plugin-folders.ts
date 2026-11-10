/**
 * The approved-plugin write consent of `@delo/plugin-instruction-consent` (C16 switch `approved_plugin_write_consent`):
 * before the agent's first write in a chat to the folder of a plugin the person approved under Changes, the person is
 * asked, and the ask names the plugin and says the agent is changing what the harness runs. A plugin's folders are the
 * `source` folder its approval names and its active directory under the Delo home, read from the profile the Host runs
 * at every write, so a plugin approved while the Host runs is covered at once and a profile without the record has
 * none. A target is inside a folder when its path, resolved lexically, is, or when its real path is: the target's own
 * when it exists, otherwise its deepest existing ancestor's with the rest of the path appended, so a symbolic link or a
 * `..` spelling into the folder asks too.
 *
 * The ask is kept per chat and plugin for the Host process's lifetime: after the person allows it, later writes to
 * that plugin's folders in the same chat pass; another chat, or the same chat after the Host restarts, asks again. A
 * refusal leaves the file unchanged and asks again at the next write. The writes still appear in Changes as pending
 * changes, which only the person applies.
 *
 * @module @delo/plugin-instruction-consent/plugin-folders
 */
import { readlink, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { WriteConsentRefusedError, type WriteConsentArgs, type WriteConsentDiff } from '@deepseek-ai/dsh-tool-fs/src/consent.ts'
import { activeDirectory, readApproved } from '@delo/changes'
import { diffText } from './classify.ts'

/** One approved plugin and the folders whose files are its content. */
export interface PluginFolders {
  /** The package name. */
  readonly plugin: string
  /** Its `source` folder and its active directory, absolute. */
  readonly folders: readonly string[]
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
 * The folders of every plugin the profile approved.
 * @param profile - the profile the Host runs.
 * @returns one entry per approved plugin; none when the profile's manifest holds no approval record.
 * @throws {ChangesError} `RECORD_UNREADABLE` when the profile's `package.json` or its record cannot be read.
 */
export async function approvedPluginFolders(profile: ConsentProfile): Promise<PluginFolders[]> {
  const record = await readApproved(profile.dir)
  return Object.entries(record.plugins).map(([plugin, approval]) => ({
    plugin,
    folders: [resolve(approval.source), activeDirectory(profile.home, profile.name, plugin)],
  }))
}

/** How many dangling symbolic links one resolution follows, as the kernel bounds a lookup. */
const LINK_HOPS = 40

/**
 * The real path of a path: its own when it exists; for a symbolic link whose target does not exist yet, which a write
 * through it creates, its target's; otherwise its deepest existing ancestor's with the rest appended.
 * @param path - an absolute path.
 * @returns the real path; the path itself when not even the root resolves.
 */
async function realPathOf(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  let hops = 0
  for (;;) {
    try {
      return join(await realpath(current), ...missing.toReversed())
    } catch {
      // ENOENT, ENOTDIR, ELOOP or EACCES: this part of the path does not resolve, so a dangling link's target or the
      // parent is tried.
    }
    const link = hops < LINK_HOPS ? await linkTarget(current) : undefined
    if (link !== undefined) {
      hops += 1
      current = resolve(dirname(current), link)
      continue
    }
    const parent = dirname(current)
    /* v8 ignore next -- the filesystem root always resolves, so the walk ends at the latest there */
    if (parent === current) return path
    missing.push(basename(current))
    current = parent
  }
}

/**
 * @param path - a path.
 * @returns what it names when it is a symbolic link, or undefined.
 */
async function linkTarget(path: string): Promise<string | undefined> {
  try {
    return await readlink(path)
  } catch {
    // EINVAL for a path that is no symbolic link, ENOENT for one that does not exist: there is no link to follow.
    return undefined
  }
}

/**
 * @param directory - an absolute directory.
 * @param path - an absolute path.
 * @returns whether the path is the directory or lies inside it.
 */
function inside(directory: string, path: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`)
}

/**
 * The approved plugin a write target belongs to.
 * @param path - the target path; a relative one resolves against the Host's working directory.
 * @param plugins - the approved plugins' folders.
 * @returns the plugin's package name, or undefined when the target is in none of their folders.
 */
export async function pluginOfTarget(path: string, plugins: readonly PluginFolders[]): Promise<string | undefined> {
  const lexical = resolve(path)
  const real = await realPathOf(lexical)
  for (const { plugin, folders } of plugins) {
    const roots = [...folders, ...await Promise.all(folders.map(realPathOf))]
    if (roots.some(root => inside(root, lexical) || inside(root, real))) return plugin
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
 * Ask before the first write in a chat to an approved plugin's folders. The listeners are prepended to the three intent
 * waterfalls every filesystem writer emits once per target, so each target of a patch is reviewed and a policy that
 * decides without calling `next()` cannot skip the ask.
 * @param ctx - the plugin context, whose `profileContext` and `approval` services are read at each write.
 */
export function askBeforePluginWrites(ctx: Context): void {
  /** The plugins each chat's person allowed writes to, by session id. */
  const allowed = new Map<string, Set<string>>()

  /**
   * Review one intent.
   * @param target - the resolved target.
   * @param actor - the tool execution that emitted the intent.
   * @throws WriteConsentRefusedError when the ask is refused, cancelled or cannot be put, or the profile's record of
   *   approved plugins cannot be read.
   */
  const review = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    const profile = ctx.get('profileContext')
    if (actor === undefined || profile === undefined) return
    const exec = actor as ToolExecution
    let plugins: PluginFolders[]
    try {
      plugins = await approvedPluginFolders(profile)
    } catch (error) {
      // readApproved rejects with a ChangesError, whose message names the file and what is wrong with it.
      throw new WriteConsentRefusedError(`the ${exec.name} to "${target.displayPath}" was not run: the profile's record of approved plugins cannot be read (${(error as Error).message})`, { cause: error })
    }
    const plugin = await pluginOfTarget(target.displayPath, plugins)
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
