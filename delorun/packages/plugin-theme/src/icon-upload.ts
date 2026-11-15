/**
 * The icon upload: the host's write check for the Branding icon. The body is checked here by its size and first bytes,
 * whatever the page already checked, and stored as the home's one icon file; the answer is the image's hash, which the
 * page then writes to the theme row.
 * @module @delorun/plugin-theme/icon-upload
 */
import { ICON_MAX_BYTES, ICON_TYPE_HEADER } from '@delorun/brand/branding'
import { storeIcon } from '@delorun/home-auth'

/**
 * A plain refusal of the icon upload.
 * @param status - the HTTP status.
 * @param problem - the reason, in plain words.
 * @returns the response.
 */
function refuse(status: number, problem: string): Response {
  return new Response(JSON.stringify({ error: problem }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Check and store an uploaded icon.
 * @param request - the POST, whose body is the image and whose `x-delorun-icon-type` header names the claimed type.
 * @param target - the icon file's path, or undefined while the home path is unknown.
 * @returns `200` with the image's hash; `413` for an oversize body; `415` for bytes that are not a PNG, JPEG or WebP image (SVG included) or that do not match the declared type; `503` without a home path.
 */
export async function receiveIcon(request: Request, target: string | undefined): Promise<Response> {
  if (target === undefined) return refuse(503, 'The studio cannot store the icon here.')
  if (Number(request.headers.get('content-length') ?? '0') > ICON_MAX_BYTES) return refuse(413, 'The icon is too large.')
  const bytes = new Uint8Array(await request.arrayBuffer())
  const type = request.headers.get(ICON_TYPE_HEADER)?.trim()
  const stored = storeIcon(target, bytes, type === '' ? undefined : type)
  if (!stored.ok) return refuse(stored.problem.startsWith('The icon is larger') ? 413 : 415, stored.problem)
  return new Response(JSON.stringify({ hash: stored.hash }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
