/**
 * The checks the doctor registry ships: this Node.js against the supported
 * range, and how completely the sandbox confines a command under the
 * deployment's mode. A check whose service the composition lacks is not
 * registered.
 * @module @deepseek-ai/dsh-doctor/checks
 */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import satisfies from 'semver/functions/satisfies.js'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { DoctorOutcome } from './index.ts'

/** Required service. The sandbox check also needs `sandbox` and `sandboxPolicy`, read when it runs. */
export const inject = ['doctor']

/** The Node.js range this installation supports, as its package declares. */
const SUPPORTED_NODE: string = (createRequire(import.meta.url)('@deepseek-ai/dsh-doctor/package.json') as { engines: { node: string } }).engines.node

/**
 * Whether a Node.js version is in the supported range.
 * @param version - the version, as `process.versions.node` gives it.
 * @returns the check's outcome.
 */
export function nodeOutcome(version: string): DoctorOutcome {
  return satisfies(version, SUPPORTED_NODE)
    ? { status: 'pass', detail: `Node.js ${version} is in the supported range ${SUPPORTED_NODE}.` }
    : { status: 'fail', detail: `Node.js ${version} is outside the supported range ${SUPPORTED_NODE}; install a supported version.` }
}

/**
 * Confine a no-op command under the deployment's default mode and read the enforcement.
 * @param ctx - context carrying the sandbox and its policy.
 * @param signal - the check's deadline.
 * @returns the check's outcome.
 */
async function sandboxOutcome(ctx: Context, signal: AbortSignal): Promise<DoctorOutcome> {
  const sandbox = ctx.get('sandbox')
  const policy = ctx.get('sandboxPolicy')?.resolve()
  if (sandbox === undefined || policy === undefined) return { status: 'warn', detail: 'This composition has no sandbox, so commands run unconfined.' }
  const { mode } = policy
  if (mode === 'danger-full-access') return { status: 'warn', detail: 'The default mode is danger-full-access, so commands run unconfined.' }
  const confined = await sandbox.confine(['true'], { ...policy, mode }, signal)
  return confined.enforcement === 'full'
    ? { status: 'pass', detail: `Commands are confined in full under ${mode}.` }
    : { status: 'warn', detail: `This machine enforces ${mode} only in part, such as on a kernel with an older Landlock ABI; a newer kernel enforces it in full.` }
}

/**
 * Register the shipped checks.
 * @param ctx - context carrying the doctor registry.
 */
export function apply(ctx: Context): void {
  ctx.doctor.register({ id: 'node-version', title: 'Node.js version', run: () => Promise.resolve(nodeOutcome(process.versions.node)) })
  ctx.doctor.register({ id: 'sandbox-enforcement', title: 'Command sandbox', run: signal => sandboxOutcome(ctx, signal) })
}
