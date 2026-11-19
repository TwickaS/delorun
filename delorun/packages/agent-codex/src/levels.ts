/**
 * The agent levels a seat's Codex thread runs at (EA34), mapped to Codex settings in this module only. Every level
 * starts the thread without a writable thread sandbox, because a thread started under `workspace-write` or
 * `danger-full-access` makes Codex write a trust entry for the folder into the person's `config.toml`; a wider sandbox
 * is set per turn instead.
 *
 * - `careful`: Codex asks when a command needs more than the sandbox gives; the run folder is the only writable root,
 *   with no network.
 * - `standard`: as `careful`, with Codex's automatic reviewer deciding first, `/tmp` and `$TMPDIR` writable and the
 *   network open, as in the person's terminal Codex.
 * - `own`: the person's own approval policy when it asks at least on request, otherwise `on-request`, and their own
 *   sandbox settings.
 * - `unrestricted`: commands run without a sandbox.
 * @module @delorun/agent-codex/levels
 */
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The levels a seat can run Codex at. */
export const CODEX_LEVELS = ['careful', 'standard', 'own', 'unrestricted'] as const
/** A level a seat can run Codex at. */
export type CodexLevel = (typeof CODEX_LEVELS)[number]

/** Codex's `workspaceWrite` sandbox policy, as `turn/start` takes it. */
export interface WorkspaceSandbox {
  readonly type: 'workspaceWrite'
  readonly writableRoots: readonly string[]
  readonly networkAccess: boolean
  readonly excludeTmpdirEnvVar: boolean
  readonly excludeSlashTmp: boolean
}

/** A sandbox policy for one turn. */
export type TurnSandbox = WorkspaceSandbox | { readonly type: 'dangerFullAccess' }

/** The approval policies a seat thread runs under. */
export type SeatApprovalPolicy = 'untrusted' | 'on-request'

/** What a level sets on the thread and on each turn. */
export interface LevelPolicy {
  /** `thread/start` and `thread/resume` settings. */
  readonly thread: {
    readonly approvalPolicy: SeatApprovalPolicy
    readonly approvalsReviewer?: 'auto_review'
    readonly sandbox?: 'read-only'
  }
  /** The sandbox policy each `turn/start` sets; absent leaves the thread's own. */
  readonly turn?: TurnSandbox
}

/**
 * The approval policy the `own` level uses: the person's configured policy when it is `untrusted` or `on-request`,
 * otherwise `on-request`, so a thread never runs under `never` or a granular policy.
 * @param configured - `approval_policy` from Codex's effective configuration, as `config/read` reports it.
 * @returns the policy.
 */
export function ownApprovalPolicy(configured: unknown): SeatApprovalPolicy {
  return configured === 'untrusted' ? 'untrusted' : 'on-request'
}

/**
 * The Codex settings for a level.
 * @param level - the seat's level.
 * @param workspace - the run folder.
 * @param own - the `own` level's approval policy, from {@link ownApprovalPolicy}.
 * @returns the thread and turn settings.
 */
export function levelPolicy(level: CodexLevel, workspace: string, own: SeatApprovalPolicy): LevelPolicy {
  switch (level) {
    case 'careful':
      return {
        thread: { approvalPolicy: 'on-request', sandbox: 'read-only' },
        turn: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      }
    case 'standard':
      return {
        thread: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'read-only' },
        turn: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      }
    case 'own':
      return { thread: { approvalPolicy: own } }
    case 'unrestricted':
      return { thread: { approvalPolicy: 'on-request', sandbox: 'read-only' }, turn: { type: 'dangerFullAccess' } }
    default:
      return assertNever(level, 'Codex level')
  }
}

/**
 * Whether the thread Codex reports runs as the level asked: the same approval policy and reviewer, and a read-only
 * thread sandbox where the level set one.
 * @param policy - the level's settings.
 * @param opened - what `thread/start` or `thread/resume` reported.
 * @param opened.approvalPolicy - the thread's approval policy.
 * @param opened.approvalsReviewer - the thread's reviewer, when reported.
 * @param opened.sandbox - the thread's sandbox policy.
 * @param opened.sandbox.type - its kind.
 * @returns whether the thread may run.
 */
export function threadMatches(policy: LevelPolicy, opened: { readonly approvalPolicy: unknown; readonly approvalsReviewer?: unknown; readonly sandbox: { readonly type: string } }): boolean {
  if (opened.approvalPolicy !== policy.thread.approvalPolicy) return false
  if (policy.thread.approvalsReviewer !== undefined && opened.approvalsReviewer !== policy.thread.approvalsReviewer) return false
  return policy.thread.sandbox === undefined || opened.sandbox.type === 'readOnly'
}
