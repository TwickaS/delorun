/**
 * The canaries a run plants: a marker word for the test chat, a fake model key, fake credential files and a workspace
 * marker file. Every value is random per run and says in itself that it is fake. A canary is never written into a card
 * or a public log: evidence names it (`model key`, `~/.ssh/id_ed25519`), never prints it.
 *
 * @module @delorun/tools/compat-bench/privacy/canaries
 */
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

/** The environment variable that names the model key the home reads. */
export const MODEL_KEY_ENV = 'DEEPSEEK_API_KEY'

/** One canary file the run plants. */
export type CanaryFile = Readonly<{
  /** The name evidence uses, such as `~/.ssh/id_ed25519`. */
  label: string
  /** The absolute path in the plugin container. */
  path: string
  content: string
  mode: number
  /** The marker the file belongs to when a plugin opens it. */
  marker: 'otherSecrets' | 'code'
  /** The one value in the file that is searched for in traffic and after uninstall. */
  secret: string
}>

/** The canaries of one run. */
export type Canaries = Readonly<{
  runId: string
  /** The word the test chat message carries. */
  chatWord: string
  /** The fake model key; also the mock model's api key. */
  modelKey: string
  files: ReadonlyArray<CanaryFile>
  /** Every searchable value by canary name: `chat word`, `model key`, then each file's label. */
  values: Readonly<Record<string, string>>
}>

/** Where the canaries go in the plugin container. */
export type CanaryLayout = Readonly<{
  /** The container user's home directory, such as `/home/bench`. */
  userHome: string
  /** The workspace directory the test chat works in. */
  workspace: string
  /** The Delorun home directory (its credentials file holds the model key). */
  delorunHome: string
}>

/** The default layout of the bench's plugin container. */
export const DEFAULT_LAYOUT: CanaryLayout = { userHome: '/home/bench', workspace: '/home/bench/workspace', delorunHome: '/home/bench/home/delorun' }

/**
 * @param bytes - how many random bytes.
 * @returns a random hexadecimal string twice that long.
 */
function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

/**
 * Make the canaries of a run.
 * @param runId - the run's id, kept in each value so a leak can be traced to its run.
 * @param layout - where the files go.
 * @returns the canaries.
 */
export function makeCanaries(runId: string, layout: CanaryLayout = DEFAULT_LAYOUT): Canaries {
  const tag = runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()
  const chatWord = `quokka-${tag}-${hex(4)}`
  const modelKey = `sk-bench-canary-${tag}-${hex(16)}`
  const sshSecret = `BENCH-FAKE-SSH-${tag}-${hex(12)}`
  const awsSecret = `bench-fake-aws-${tag}-${hex(12)}`
  const ghSecret = `bench-fake-gh-${tag}-${hex(12)}`
  const envSecret = `bench-fake-env-${tag}-${hex(12)}`
  const markerText = `bench-fake-workspace-marker-${tag}-${hex(12)}`
  const begin = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ')
  const end = ['-----END', 'OPENSSH PRIVATE KEY-----'].join(' ')
  const files: CanaryFile[] = [
    { label: '~/.ssh/id_ed25519', path: posix.join(layout.userHome, '.ssh/id_ed25519'), content: `${begin}\n${sshSecret}\nfake key planted by the bench, not a real key\n${end}\n`, mode: 0o600, marker: 'otherSecrets', secret: sshSecret },
    { label: '~/.aws/credentials', path: posix.join(layout.userHome, '.aws/credentials'), content: `[default]\n# fake, planted by the bench\naws_access_key_id = AKIAFAKEBENCH${hex(4).toUpperCase()}\naws_secret_access_key = ${awsSecret}\n`, mode: 0o600, marker: 'otherSecrets', secret: awsSecret },
    { label: '~/.config/gh/hosts.yml', path: posix.join(layout.userHome, '.config/gh/hosts.yml'), content: `# fake, planted by the bench\ngithub.com:\n  user: bench-fake\n  oauth_token: ${ghSecret}\n`, mode: 0o600, marker: 'otherSecrets', secret: ghSecret },
    { label: 'workspace .env', path: posix.join(layout.workspace, '.env'), content: `# fake, planted by the bench\nBENCH_FAKE_SERVICE_TOKEN=${envSecret}\n`, mode: 0o600, marker: 'otherSecrets', secret: envSecret },
    { label: 'workspace marker file', path: posix.join(layout.workspace, 'bench-marker.txt'), content: `${markerText}\nA file planted by the bench to see whether a plugin reads or changes your workspace.\n`, mode: 0o644, marker: 'code', secret: markerText },
  ]
  const values: Record<string, string> = { 'chat word': chatWord, 'model key': modelKey }
  for (const file of files) values[file.label] = file.secret
  return { runId, chatWord, modelKey, files, values }
}

/**
 * The paths a plugin opening is logged for, with the name evidence gives them.
 * @param canaries - the run's canaries.
 * @param layout - where they are.
 * @returns the watch list: an entry ending in `/` matches everything below it.
 */
export function watchList(canaries: Canaries, layout: CanaryLayout = DEFAULT_LAYOUT): ReadonlyArray<{ label: string; path: string }> {
  return [
    ...canaries.files.map(file => ({ label: file.label, path: file.path })),
    { label: '~/.ssh/', path: `${posix.join(layout.userHome, '.ssh')}/` },
    { label: '~/.aws/', path: `${posix.join(layout.userHome, '.aws')}/` },
    { label: '~/.config/gh/', path: `${posix.join(layout.userHome, '.config/gh')}/` },
    { label: 'Delorun key store', path: posix.join(layout.delorunHome, 'credentials.yaml') },
    { label: 'Delorun home secrets', path: `${posix.join(layout.delorunHome, 'secrets')}/` },
  ]
}
