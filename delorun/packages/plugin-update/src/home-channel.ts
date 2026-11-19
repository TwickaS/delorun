/**
 * The Host's side of the update channel for the studio's update routes (contract C19, "The studio's update"): the
 * home process's refusal codes in the person's words, and an exchange whose answer comes before the Host stops. The
 * channel token stays inside the {@link UpdateChannelAccess} this module is given; nothing here returns it.
 *
 * @module @delorun/plugin-update/home-channel
 */
import type { ResponseLine, UnsignedRequest, UpdateChannelAccess } from '@delorun/home-process'
import { RouteRefusal } from '@delorun/plugin-changes'
import type { UpdateRefusalCode } from './wire.ts'

/** A home-process refusal as the page sees it. */
interface Said {
  readonly status: number
  readonly code: UpdateRefusalCode
  readonly sentence: string
}

/** What each home-process error code says to the person; a code not listed answers `UPDATE_FAILED`. */
const SAID: Readonly<Record<string, Said>> = {
  UPDATE_IN_PROGRESS: { status: 409, code: 'UPDATE_IN_PROGRESS', sentence: 'An update or a rollback of Delorun is already running.' },
  RESTART_IN_PROGRESS: { status: 409, code: 'RESTART_IN_PROGRESS', sentence: 'Delorun is restarting; try again once it has.' },
  REPORT_EXPIRED: { status: 409, code: 'REPORT_EXPIRED', sentence: 'The report is older than ten minutes. Check what the update changes again.' },
  HARNESS_CHANGES_PENDING: { status: 409, code: 'HARNESS_CHANGES_PENDING', sentence: 'Changes to Delorun itself wait for your review. Review them in Settings → Changes, then update.' },
  HARNESS_REPORT_STALE: { status: 409, code: 'HARNESS_REPORT_STALE', sentence: 'Changes to Delorun itself differ from the report you saw. Check what the update changes again.' },
  HARNESS_COPY_UNREADABLE: { status: 409, code: 'HARNESS_COPY_UNREADABLE', sentence: 'Delorun could not read the files you changed in itself, so it did not update. The Host log says why.' },
  DATA_COPY_NO_SPACE: { status: 409, code: 'DATA_COPY_NO_SPACE', sentence: 'There is not room for the copy of your chats. Free some space, or update without the copy.' },
  CHATS_RUNNING: { status: 409, code: 'CHATS_RUNNING', sentence: 'Chats are running, or another program uses your chat data. Nothing changed.' },
  NO_UPDATE_RECORD: { status: 409, code: 'NO_UPDATE_RECORD', sentence: 'There is no update to go back from.' },
  ROLLBACK_NEEDS_DATA_COPY: { status: 409, code: 'ROLLBACK_NEEDS_DATA_COPY', sentence: 'No copy of your chats exists from before the update, so only your settings can go back.' },
  ROLLBACK_TARGET_UNUSABLE: { status: 409, code: 'ROLLBACK_TARGET_UNUSABLE', sentence: 'The earlier release cannot run any more, so Delorun did not go back. Nothing changed.' },
  NO_RUNTIME_STORE: { status: 409, code: 'NO_RUNTIME_STORE', sentence: 'Delorun updates itself only as an installed release started with delorun start.' },
  VERIFY_FAILED: { status: 502, code: 'VERIFY_FAILED', sentence: 'Delorun could not verify the release, so it installed nothing.' },
  CHANNEL_UNREACHABLE: { status: 502, code: 'CHANNEL_UNREACHABLE', sentence: 'Delorun could not reach the release channel. Check your connection and try again.' },
  GIT_UNAVAILABLE: { status: 409, code: 'GIT_UNAVAILABLE', sentence: 'Delorun needs git to keep your settings safe across the update, and cannot run it. Install git and try again.' },
  TARGET_LOWER: { status: 409, code: 'TARGET_LOWER', sentence: 'The newest release is older than the one you run, so Delorun did not install it.' },
}

/**
 * @param code - a home-process error code, or undefined.
 * @returns the refusal the page reads; the Host log carries what a code not listed means.
 */
export function refusalFor(code: string | undefined): RouteRefusal {
  const said = code === undefined ? undefined : SAID[code]
  if (said !== undefined) return new RouteRefusal(said.status, said.code, said.sentence)
  return new RouteRefusal(502, 'UPDATE_FAILED', 'Delorun could not do that. The Host log says why.')
}

/** What {@link begin} returns: the first line the home process answered, and the rest of the exchange. */
export interface Begun {
  /** The first response line; never a refusal. */
  readonly first: ResponseLine
  /** Settles with every line when the home process closes the connection, which a switch or a stop may never do before this Host ends. */
  readonly done: Promise<ResponseLine[]>
}

/**
 * Send one request and resolve with its first response line, leaving the exchange open: an update's final line arrives
 * only when the Host this runs in is still there to read it, and a stop's never does.
 * @param access - the Host's way to the update channel.
 * @param request - the request without `v` and `token`.
 * @returns the first line and the exchange.
 * @throws {RouteRefusal} the refusal of a first line `{ ok: false }`; `503 UPDATE_UNAVAILABLE` when the channel is not open or closes without an answer.
 */
export function begin(access: UpdateChannelAccess, request: UnsignedRequest): Promise<Begun> {
  return new Promise<Begun>((resolve, reject) => {
    let settled = false
    const answer = (first: ResponseLine, done: Promise<ResponseLine[]>): void => {
      if (settled) return
      settled = true
      if (first.ok) resolve({ first, done })
      else reject(refusalFor(typeof first.error === 'string' ? first.error : undefined))
    }
    let exchange: Promise<ResponseLine[]> | undefined
    let early: ResponseLine | undefined
    const done: Promise<ResponseLine[]> = access.send(request, {
      onLine: (line) => {
        if (exchange === undefined) early ??= line
        else answer(line, exchange)
      },
    })
    exchange = done
    if (early !== undefined) answer(early, done)
    done.then((lines) => {
      const first = lines[0]
      if (first !== undefined) answer(first, done)
      else if (!settled) { settled = true; reject(new RouteRefusal(502, 'UPDATE_FAILED', 'The home process closed the channel without answering.')) }
    }, () => {
      if (settled) return
      settled = true
      reject(unavailable())
    })
  })
}

/**
 * Send one request and read its final line.
 * @param access - the Host's way to the update channel.
 * @param request - the request without `v` and `token`.
 * @param onLine - receives each line as it arrives.
 * @returns the final line, which is not a refusal.
 * @throws {RouteRefusal} the refusal of a final line `{ ok: false }`; `503 UPDATE_UNAVAILABLE` when the channel is not open.
 */
export async function finish(access: UpdateChannelAccess, request: UnsignedRequest, onLine?: (line: ResponseLine) => void): Promise<ResponseLine> {
  let lines: ResponseLine[]
  try {
    lines = await access.send(request, onLine === undefined ? {} : { onLine })
  } catch (_notOpen) {
    // The channel is not open: the refusal says so; the Host log has no more to add.
    throw unavailable()
  }
  const last = lines.at(-1)
  if (last === undefined) throw new RouteRefusal(502, 'UPDATE_FAILED', 'The home process closed the channel without answering.')
  if (!last.ok) throw refusalFor(typeof last.error === 'string' ? last.error : undefined)
  return last
}

/**
 * @returns the refusal: the channel is not open, as when a successor holds the home or the home process stopped.
 */
function unavailable(): RouteRefusal {
  return new RouteRefusal(503, 'UPDATE_UNAVAILABLE', 'Delorun cannot reach its home process now. Try again in a moment.')
}
