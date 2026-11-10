/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploads } from './index.ts'
import type { FileUploadValue, ImageUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue | ImageUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Admit a Peer other than the owner to the raw route exactly where remote
 * access allows it the `fileUploads/upload` Remote method on the Session the
 * `sessionId` query names, so the route grants no Peer more than that method.
 * @param access - the Host's remote access, absent when the composition mounts none.
 * @param request - the raw upload request; only its URL is read.
 * @param peer - the calling Peer.
 * @returns whether the Peer may upload to the named Session; false without a
 *   named Session or without remote access.
 */
export function admitsUploadPeer(access: Pick<RemoteAccessService, 'decide'> | undefined, request: Request, peer: PeerScope): boolean {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (access === undefined || sessionId === null || sessionId === '') return false
  return access.decide({
    principal: peer.principal,
    action: 'fileUploads/upload',
    resources: [{ kind: 'session', id: brandString<SessionId>(sessionId) }],
  }).kind === 'allow'
}

/**
 * Handle one authenticated raw-byte upload. A `mediaType` query parameter
 * stages the body as a prompt image; without it the body is stored verbatim.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @returns JSON result using HTTP status 200 after request validation.
 */
export async function handleFileUploadHttp(service: FileUploads, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const name = url.searchParams.get('name') ?? undefined
  const imageMediaType = url.searchParams.get('mediaType') ?? undefined
  const upload = {
    sessionId: brandString<SessionId>(sessionId),
    data: requestBodyChunks(request.body),
    signal: request.signal,
    ...(name === undefined ? {} : { name }),
  }
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: imageMediaType === undefined
        ? await service.uploadStream(upload)
        : await service.uploadImageStream({ ...upload, mediaType: imageMediaType }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
