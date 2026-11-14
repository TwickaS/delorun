/**
 * How a {@link HomeProcessError} reads in `@delorun/home`'s refusal format: what Delorun did for contract C19's code, the
 * code and detail, and the commands that show or change where the profile stands. A detail that names its own
 * remedy, such as `ROLLBACK_NEEDS_DATA_COPY`'s, stays in the reason.
 *
 * @module @delorun/home-process/refusal
 */
import { codedReason, profileOption, refusalDescriber, type Refusal, type RefusalContext, type RefusalDescriber } from '@delorun/home'
import { HomeProcessError } from './errors.ts'

/**
 * The lead and remedies for one error.
 * @param error - the error.
 * @param context - the profile a remedy's command names.
 * @returns the lead sentence and the remedies.
 */
function homeProcessRefusal(error: HomeProcessError, context: RefusalContext): Omit<Refusal, 'reason'> {
  const profile = profileOption(context)
  const again = 'Run the same command again.'
  const recoverStatus = `See where the profile stands: delorun recover status${profile}`
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return { lead: 'The home process refused the request: it did not carry this start\'s token.', remedies: [`Check which Delorun runs for the profile: delorun status${profile}`] }
    case 'SCHEMA_VIOLATION':
      return { lead: 'The home process refused a request it does not read.', remedies: ['Report this if it repeats.'] }
    case 'REQUEST_TIMEOUT':
      return { lead: 'The home process closed the request because no request arrived in time.', remedies: [again] }
    case 'REQUEST_TOO_LARGE':
      return { lead: 'The home process refused a request larger than it accepts.', remedies: ['Report this if it repeats.'] }
    case 'BUSY':
      return { lead: 'The home process refused the request because too many connections are open.', remedies: [again] }
    case 'UPDATE_IN_PROGRESS':
      return { lead: 'Delorun did not start this: an update or rollback already runs.', remedies: [`Wait for it to end, then check: delorun status${profile}`] }
    case 'REPORT_EXPIRED':
      return { lead: 'Delorun did not update: the update report is unknown or older than ten minutes.', remedies: [`Read a fresh report and confirm it: delorun update${profile}`] }
    case 'UPDATE_PENDING':
      return { lead: 'Delorun started no new turn: an update is waiting for running chats.', remedies: ['Send it again once Delorun is back.'] }
    case 'CHATS_RUNNING':
      return { lead: 'Delorun did not go ahead: chats are running.', remedies: ['Wait for the chats to finish, then run the same command again.'] }
    case 'DRAIN_TIMEOUT':
      return { lead: 'Delorun did not update: running chats did not finish in time.', remedies: ['Wait for the chats to finish, then run the same command again.'] }
    case 'HEALTH_CHECK_FAILED':
      return { lead: 'The new release did not pass its health check.', remedies: [recoverStatus] }
    case 'VERIFY_FAILED':
      return { lead: 'Delorun refused a release that did not verify.', remedies: ['See every check: delorun verify'] }
    case 'CHANNEL_UNREACHABLE':
      return { lead: 'Delorun did not update: the release channel could not be reached, and nothing was downloaded or changed.', remedies: ['Check this computer\'s connection, then run the same command again.'] }
    case 'GIT_UNAVAILABLE':
      return { lead: 'Delorun did not go ahead: git, which saves and restores the profile\'s history, cannot run here, and nothing was changed.', remedies: ['Install git, then run the same command again.'] }
    case 'HARNESS_CHANGES_PENDING':
      return { lead: 'Delorun did not update: your changes to Delorun itself wait for review, and an update would leave them behind.', remedies: ['Apply or discard them: delorun changes list', 'Then run the same command again.'] }
    case 'HARNESS_COPY_UNREADABLE':
      return {
        lead: 'Delorun did not update: it could not read your copy of Delorun itself, so it cannot tell whether changes there wait for review, and it kept the release it runs.',
        remedies: [`Take back every change in the copy: delorun changes edit-harness --discard${profile}`, `Or fix the copy, then see its changes: delorun changes list${profile}`, 'Then run the same command again.'],
      }
    case 'HARNESS_REPORT_STALE':
      return { lead: 'Delorun did not update: what it would now do with your changes to Delorun itself differs from the report you confirmed, and it kept the release it runs.', remedies: [`Read the new report and confirm it: delorun update${profile}`] }
    case 'NO_PREVIOUS':
      return { lead: 'Delorun did not roll back: no previous release is installed.', remedies: [] }
    case 'NO_UPDATE_RECORD':
      return { lead: 'Delorun did not roll back: no update to the running version is recorded.', remedies: [recoverStatus] }
    case 'DATA_COPY_NO_SPACE':
      return { lead: 'Delorun did not copy the chat data: the copy does not fit on the home\'s disk.', remedies: ['Free space on that disk, then run the same command again.'] }
    case 'ROLLBACK_NEEDS_DATA_COPY':
      return {
        lead: 'Delorun did not roll back: going back would hand newer chat data to an older release, and no copy of the older data exists.',
        remedies: [`Restore the profile and keep this release: delorun recover rollback --profile-only${profile}`, `Start in safe mode: delorun recover safe-mode${profile}`],
      }
    case 'ROLLBACK_TARGET_UNUSABLE':
      return { lead: 'Delorun did not roll back: the version it would return to is not installed or fails its start check.', remedies: [recoverStatus] }
    case 'HOST_STOP_FAILED':
      return { lead: 'Delorun did not switch releases: the studio host did not stop in time, and it runs again.', remedies: [again] }
    case 'NO_RUNTIME_STORE':
      return { lead: 'Delorun did not start: an unfinished update needs the runtime store, and this delorun runs outside it.', remedies: ['Start Delorun through the launcher the Delorun home installs.', recoverStatus] }
    case 'LOOPBACK_REQUIRED':
      return {
        lead: 'The home process refused the request: only the person\'s own delorun on this computer manages devices and remote access and answers or revokes an MCP server.',
        remedies: [`Approve the device at this computer: delorun devices approve${profile}`, `Answer the MCP server at this computer: delorun mcp accept <server>${profile}`],
      }
    case 'APPROVAL_FAILED':
      return { lead: 'Delorun did not approve or cancel the device request.', remedies: [`Wait for the device's request again: delorun devices approve${profile}`] }
    case 'APPROVALS_UNAVAILABLE':
      return { lead: 'Delorun did not change any device: the running profile does not load remote access.', remedies: [`Turn remote access on, then restart Delorun: delorun reach on tailscale${profile}`] }
    case 'REMOVAL_FAILED':
      return { lead: 'Delorun did not remove the device.', remedies: [`See the trusted devices: delorun devices list${profile}`] }
    case 'ELEVATION_FAILED':
      return { lead: 'Delorun did not unlock sensitive actions on the device, or did not end the unlock.', remedies: [`See the requests and the running unlocks again: delorun devices elevate${profile}`] }
    case 'CONSENT_UNAVAILABLE':
      return { lead: 'Delorun changed nothing: the running profile does not ask this consent, because its switch is off.', remedies: [`See which prompts the profile asks: delorun setup prompts${profile}`] }
    case 'STALE_REVIEW':
      return { lead: 'Delorun changed nothing: what you answered changed after it was shown.', remedies: [`Look at it again: delorun mcp list${profile}`] }
    case 'CONSENT_FAILED':
      return { lead: 'Delorun did not record the answer.', remedies: [again] }
    case 'REACH_UNAVAILABLE':
      return { lead: 'Delorun did not apply remote access to the running home: its profile does not run the reach service now.', remedies: [`Restart Delorun to apply it: delorun stop${profile}, then delorun start${profile}`] }
    case 'STUDIO_UNAVAILABLE':
      return { lead: 'Delorun did not open the studio: the running home process could not make a sign-in link for this computer.', remedies: [`See whether Delorun runs and where its studio listens: delorun status${profile}`] }
  }
}

/** How a {@link HomeProcessError} reads: what Delorun did for C19's code, the code and detail, and the commands that help. */
export const homeProcessDescriber: RefusalDescriber<HomeProcessError> = refusalDescriber(HomeProcessError, (error, context) => ({
  ...homeProcessRefusal(error, context),
  reason: codedReason(error.code, error.detail),
}))
