/**
 * A local HTTPS git server for the clone specs: a self-signed certificate for
 * 127.0.0.1 and `localhost` made with openssl, `git http-backend` behind it, a public
 * repository, a private repository that needs a Basic credential, a
 * repository whose advertisement never arrives, and a repository that redirects
 * to the private one. It reaches no real host or account.
 * @module tests/fixtures/git-server
 */
import { execFile, spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The user name of the private repository's credential, the form GitHub installation tokens take. */
const USER = 'x-access-token'

/** The private repository's password, a fake value. */
const PASSWORD = 'fixture-password-not-a-credential'

/** The repository whose advertisement the server never sends. */
const STALL = 'stall.git'

/** The repositories whose requests the server answers with a redirect to another repository of the fixture, by directory name. */
const REDIRECTS: ReadonlyMap<string, string> = new Map([['moved.git', 'private.git']])

/** The repositories served with an answer, by directory name. */
const SERVED = new Set<string>(['public.git', 'private.git'])

/** One request the server received. */
export interface FixtureRequest {
  /** The HTTP method. */
  readonly method: string
  /** The request path, such as `/private.git/info/refs`. */
  readonly path: string
  /** Whether the request carried the private repository's credential. */
  readonly credential: boolean
}

/** A running fixture server. */
export interface GitFixture {
  /** The server's origin, `https://127.0.0.1:<port>`. */
  readonly origin: string
  /** The PEM file of the self-signed certificate, the authority a clone trusts through its extra certificate file. */
  readonly caFile: string
  /** The home directory the fixture's git commands and clones use; it holds no git configuration unless a spec writes one. */
  readonly home: string
  /** The environment of the fixture's git commands and of the clones the specs run: the harness's variables without the `GIT_` names, with the fixture's home. */
  readonly env: NodeJS.ProcessEnv
  /** The private repository's password; its user name is `x-access-token`. */
  readonly password: string
  /** The requests the server has received, in arrival order. */
  readonly requests: readonly FixtureRequest[]
  /** Stops the server, ends its connections and removes the fixture's files. */
  close(): Promise<void>
}

/** The CGI response of `git http-backend`, parsed. */
interface CgiResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Buffer
}

/** What the request handler needs from the running fixture. */
interface ServerState {
  readonly repos: string
  readonly home: string
  readonly env: NodeJS.ProcessEnv
  readonly expected: string
  readonly requests: FixtureRequest[]
}

/**
 * Start the fixture on a free port of 127.0.0.1.
 * @returns the running fixture.
 * @throws Error naming openssl when `openssl version` cannot run, and the failure of any command that builds the repositories.
 */
export async function startGitFixture(): Promise<GitFixture> {
  await requireOpenssl()
  const root = await mkdtemp(join(tmpdir(), 'delo-git-fixture-'))
  const home = join(root, 'home')
  const repos = join(root, 'repos')
  await mkdir(home)
  const env = isolatedEnv(home)
  const caFile = join(root, 'cert.pem')
  const keyFile = join(root, 'key.pem')
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', caFile, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE'])
  await buildRepositories(root, repos, env)
  const requests: FixtureRequest[] = []
  const state: ServerState = { repos, home, env, expected: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`, requests }
  const server = createServer({ key: await readFile(keyFile), cert: await readFile(caFile) }, (req, res) => {
    serve(req, res, state).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(messageOf(error))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the git fixture server has no TCP address')
  return {
    origin: `https://127.0.0.1:${address.port}`,
    caFile,
    home,
    env,
    password: PASSWORD,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Fail with a message that names openssl when it is not on PATH.
 * @throws Error naming openssl.
 */
async function requireOpenssl(): Promise<void> {
  try {
    await run('openssl', ['version'])
  } catch (error) {
    throw new Error(`the git clone specs need openssl on PATH to make the fixture's certificate: ${messageOf(error)}`, { cause: error })
  }
}

/**
 * Create the public and private bare repositories, each with one commit.
 * @param root - the fixture's directory.
 * @param repos - the directory the bare repositories go in.
 * @param env - the environment of the git commands.
 */
async function buildRepositories(root: string, repos: string, env: NodeJS.ProcessEnv): Promise<void> {
  const work = join(root, 'work')
  await git(['init', '--quiet', '--initial-branch=main', work], env)
  await writeFile(join(work, 'README.md'), 'A repository the clone specs fetch through the fixture.\n')
  await git(['-C', work, 'add', 'README.md'], env)
  await git(['-C', work, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Initial commit'], env)
  await mkdir(repos)
  for (const name of SERVED) {
    const bare = join(repos, name)
    await git(['init', '--quiet', '--bare', '--initial-branch=main', bare], env)
    await git(['-C', work, 'push', '--quiet', bare, 'HEAD:refs/heads/main'], env)
  }
}

/**
 * Run one git command.
 * @param args - the arguments after `git`.
 * @param env - the command's environment.
 */
async function git(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  await run('git', [...args], { env })
}

/**
 * The environment of the fixture's git commands and of the clones the specs run: the harness's variables without the `GIT_`
 * names, which could point a command at another repository, and a home of the fixture's own.
 * @param home - the fixture's home directory.
 * @returns the environment.
 */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' }
}

/**
 * Answer one request: record it, require the credential for the private
 * repository, and answer the others from `git http-backend`.
 * @param req - the request.
 * @param res - the response.
 * @param state - the running fixture.
 */
async function serve(req: IncomingMessage, res: ServerResponse, state: ServerState): Promise<void> {
  const url = new URL(req.url ?? '/', 'https://127.0.0.1')
  const credential = req.headers.authorization === state.expected
  const repository = url.pathname.split('/')[1] ?? ''
  state.requests.push({ method: req.method ?? 'GET', path: url.pathname, credential })
  if (repository === STALL) return
  const target = REDIRECTS.get(repository)
  if (target !== undefined) {
    res.writeHead(301, { Location: `/${target}${url.pathname.slice(repository.length + 1)}${url.search}` }).end()
    return
  }
  if (!SERVED.has(repository)) {
    res.writeHead(404).end()
    return
  }
  if (repository === 'private.git' && !credential) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end()
    return
  }
  const body = await readBody(req)
  const cgi = await runHttpBackend(state, req, url, body)
  res.writeHead(cgi.status, cgi.headers).end(cgi.body)
}

/**
 * Run `git http-backend` for one request.
 * @param state - the running fixture.
 * @param req - the request, whose headers the CGI environment takes.
 * @param url - the request's URL.
 * @param body - the request's body, already read.
 * @returns the parsed CGI response, or status 500 with git's stderr when the command fails without output.
 */
function runHttpBackend(state: ServerState, req: IncomingMessage, url: URL, body: Buffer): Promise<CgiResponse> {
  const env = definedEntries({
    PATH: state.env.PATH,
    HOME: state.home,
    XDG_CONFIG_HOME: join(state.home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_PROJECT_ROOT: state.repos,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method ?? 'GET',
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.slice(1),
    CONTENT_LENGTH: String(body.length),
    REMOTE_ADDR: '127.0.0.1',
    CONTENT_TYPE: header(req, 'content-type'),
    HTTP_CONTENT_ENCODING: header(req, 'content-encoding'),
    HTTP_GIT_PROTOCOL: header(req, 'git-protocol'),
  })
  return new Promise<CgiResponse>((resolve, reject) => {
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => { out.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { err.push(chunk) })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 && out.length === 0) resolve({ status: 500, headers: {}, body: Buffer.concat(err) })
      else resolve(parseCgi(Buffer.concat(out)))
    })
    // git http-backend may exit before it reads the body, which makes this write fail; its response decides the outcome.
    child.stdin.on('error', () => undefined)
    child.stdin.end(body)
  })
}

/**
 * Split a CGI response into its status, headers and body.
 * @param output - the bytes `git http-backend` wrote to standard output.
 * @returns the status (200 without a `Status` header), the other headers, and the body.
 */
function parseCgi(output: Buffer): CgiResponse {
  const text = output.toString('latin1')
  const separator = /\r?\n\r?\n/.exec(text)
  const head = separator === null ? text : text.slice(0, separator.index)
  const body = separator === null ? Buffer.alloc(0) : output.subarray(separator.index + separator[0].length)
  let status = 200
  const headers: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
    else headers[name] = value
  }
  return { status, headers, body }
}

/**
 * Read a request body to the end.
 * @param req - the request.
 * @returns the body bytes.
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/**
 * One request header, when it is a single value.
 * @param req - the request.
 * @param name - the lower-case header name.
 * @returns the value, or undefined when the header is absent or repeated.
 */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * The entries whose values are defined, as a child environment.
 * @param entries - the candidate environment entries.
 * @returns the defined entries.
 */
function definedEntries(entries: Record<string, string | undefined>): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [name, value] of Object.entries(entries)) {
    if (value !== undefined) defined[name] = value
  }
  return defined
}

/**
 * The message of a thrown value.
 * @param error - the value a catch clause received.
 * @returns the error's message, or the value as a string.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
