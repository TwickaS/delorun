// Runs inside a bench container. `node /opt/bench/ctl.mjs <command> [--flag value]...` prints one JSON line.
// Commands: setup, mock-start, studio-start, studio-stop, link, rss, plugin-add, plugin-remove, doctor, verify.
// The container is the bench's sandbox; nothing here touches anything outside it.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const KIND = process.env.BENCH_HOST_KIND ?? 'delorun'
const HOME = process.env.HOME ?? '/home/bench'
const HOME_DIR = join(HOME, 'home', 'delorun')
const STATE = '/tmp/bench-state'
const OUT_LOGS = '/out/logs'
const STUDIO_PORT = 18590
const MOCK_PORT = 18591
/** A placeholder, not a key: the mock model accepts anything, and the container holds no real key. */
const MOCK_KEY = process.env.DEEPSEEK_API_KEY ?? 'bench-mock-not-a-key'

const [command, ...rest] = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true' } else positional.push(rest[i])
}

mkdirSync(STATE, { recursive: true })
mkdirSync(OUT_LOGS, { recursive: true })

/** The environment of a command of the host under test. */
function secretEnv() {
  // Values the caller handed over with --secret-env-file; never printed or logged here.
  const file = join(HOME, '.bench-secrets.env')
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
}

function hostEnv(extra = {}) {
  return {
    ...secretEnv(),
    ...process.env,
    HOME,
    ...(KIND === 'delorun' ? { DELORUN_HOME: HOME_DIR } : { DSH_HOME: HOME_DIR }),
    DEEPSEEK_API_KEY: MOCK_KEY,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ...extra,
  }
}

/** The command line of the host's own CLI. */
const cli = KIND === 'delorun' ? ['delorun'] : ['dsh']

function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function sleep(ms) { return new Promise(done => setTimeout(done, ms)) }
function pidFile(name) { return join(STATE, `${name}.pid`) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

/** Run a command to its end, keeping the output in a log. */
function run(argv, { log, timeout = 600_000, env = hostEnv(), cwd } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout, env, cwd, maxBuffer: 64 * 1024 * 1024 })
  const text = `$ ${argv.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\n[exit ${result.status ?? result.signal}]\n`
  if (log) appendFileSync(join(OUT_LOGS, log), text)
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Start a detached process in its own group, output to a log. */
function startDetached(name, argv, { env = hostEnv(), cwd } = {}) {
  const seq = existsSync(join(STATE, `${name}.seq`)) ? Number(readFileSync(join(STATE, `${name}.seq`), 'utf8')) + 1 : 1
  writeFileSync(join(STATE, `${name}.seq`), String(seq))
  const logPath = join(OUT_LOGS, `${name}-${seq}.log`)
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', openLog(logPath), openLog(logPath)], env, cwd })
  child.unref()
  writeFileSync(pidFile(name), String(child.pid))
  writeFileSync(join(STATE, `${name}.log`), logPath)
  return { pid: child.pid, logPath }
}
import { openSync } from 'node:fs'
function openLog(path) { return openSync(path, 'a') }

async function listening(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)
    if (ok) return true
    await sleep(500)
  }
  return false
}

function stopProcess(name) {
  const file = pidFile(name)
  if (!existsSync(file)) return false
  const pid = Number(readFileSync(file, 'utf8'))
  try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
  return pid
}

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (!alive(pid)) return true; await sleep(250) }
  try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
  return !alive(pid)
}

/** Sum of resident memory of every process in a group, in bytes. */
function groupRss(pgid) {
  let total = 0
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) !== pgid) continue
      const kb = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))
      if (kb) total += Number(kb[1]) * 1024
    } catch { /* process ended */ }
  }
  return total
}

const handlers = {
  async setup() {
    if (KIND === 'delorun') {
      const r = run([...cli, 'setup', '--yes', '--provider', 'deepseek-official', '--key-env', 'DEEPSEEK_API_KEY', '--no-update-check'], { log: 'setup.log' })
      if (r.code !== 0) return print({ ok: false, code: r.code, output: (r.stdout + r.stderr).slice(-2000) })
      const patch = join(HOME_DIR, 'profiles/default/cordis.patch.yml')
      appendFileSync(patch, `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${STUDIO_PORT}\n`)
      return print({ ok: true })
    }
    return print({ ok: true, note: 'stock has no setup command' })
  },
  async 'mock-start'() {
    const mock = startDetached('mock', ['node', '/opt/bench/mock.mjs', String(MOCK_PORT)])
    const up = await listening(MOCK_PORT, 15_000).catch(() => false)
    return print({ ok: up || alive(mock.pid), pid: mock.pid })
  },
  async 'studio-start'() {
    const began = Date.now()
    const argv = KIND === 'delorun' ? [...cli, 'start', '--foreground'] : [...cli, 'web', '--host', '127.0.0.1', '--port', String(STUDIO_PORT), '--no-open']
    const studio = startDetached('studio', argv)
    const up = await listening(STUDIO_PORT, Number(flags.timeout ?? 240_000))
    return print({ ok: up, startMs: Date.now() - began, pid: studio.pid, log: studio.logPath, port: STUDIO_PORT, exited: !alive(studio.pid) })
  },
  async 'studio-stop'() {
    const pid = stopProcess('studio')
    if (pid === false) return print({ ok: true, note: 'not running' })
    if (KIND === 'delorun') run([...cli, 'stop', '--now'], { log: 'stop.log', timeout: 60_000 })
    return print({ ok: await waitGone(pid, 20_000) })
  },
  async 'mock-stop'() {
    const pid = stopProcess('mock')
    return print({ ok: pid === false ? true : await waitGone(pid, 5000) })
  },
  async link() {
    if (KIND === 'delorun') {
      const r = run([...cli, 'open', '--print'], { log: 'open.log', timeout: 60_000 })
      const link = /http:\/\/127[^\s]+/.exec(r.stdout)?.[0]
      return print({ ok: link !== undefined, link })
    }
    const logPath = readFileSync(join(STATE, 'studio.log'), 'utf8')
    const link = /http:\/\/127[^\s]+/.exec(readFileSync(logPath, 'utf8'))?.[0]
    return print({ ok: link !== undefined, link })
  },
  async rss() {
    const pid = Number(readFileSync(pidFile('studio'), 'utf8'))
    return print({ ok: true, rssBytes: groupRss(pid) })
  },
  async 'plugin-add'() {
    const spec = positional[0]
    const argv = KIND === 'delorun' ? [...cli, 'plugin', 'add', spec] : [...cli, 'plugin', '--profile', 'default', 'add', spec]
    const r = run([...argv, ...(flags['allow-build'] ? ['--allow-build', flags['allow-build']] : [])], { log: 'install.log', timeout: 900_000 })
    return print({ ok: r.code === 0, code: r.code, output: (r.stdout + r.stderr).slice(-6000) })
  },
  async 'plugin-remove'() {
    const spec = positional[0]
    const argv = KIND === 'delorun' ? [...cli, 'plugin', 'remove', spec] : [...cli, 'plugin', '--profile', 'default', 'remove', spec]
    const r = run(argv, { log: 'uninstall.log', timeout: 600_000 })
    return print({ ok: r.code === 0, code: r.code, output: (r.stdout + r.stderr).slice(-6000) })
  },
  async doctor() {
    if (KIND !== 'delorun') return print({ ok: true, skipped: 'stock has no doctor' })
    const d = run([...cli, 'doctor'], { log: 'doctor.log', timeout: 120_000 })
    const v = run([...cli, 'verify', '--offline'], { log: 'verify.log', timeout: 120_000 })
    return print({ ok: d.code === 0 && v.code === 0, doctor: d.code, verify: v.code, doctorOutput: d.stdout.slice(-2000), verifyOutput: v.stdout.slice(-2000) })
  },
  async version() {
    const r = run([...cli, '--version'], { timeout: 60_000 })
    return print({ ok: r.code === 0, version: r.stdout.trim().split('\n').pop() })
  },
  async tree() {
    // The files under the home, for the leftovers comparison.
    const out = []
    const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); const s = statSync(p); out.push(p.slice(HOME_DIR.length)); if (s.isDirectory() && name !== 'node_modules') walk(p) } }
    if (existsSync(HOME_DIR)) walk(HOME_DIR)
    return print({ ok: true, files: out })
  },
}

if (!handlers[command]) { print({ ok: false, error: `unknown command ${command}` }); process.exit(2) }
await handlers[command]()
