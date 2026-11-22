/**
 * A thin wrapper over the `docker` command for the privacy observer, so tests can swap in a fake. Every object the
 * observer creates carries the label `delorun.bench=1`, and it removes only what it created.
 *
 * @module @delorun/tools/compat-bench/privacy/docker
 */
import { execFile } from 'node:child_process'

/** The result of one docker command. */
export type DockerResult = Readonly<{ stdout: string; stderr: string; status: number }>

/** Runs `docker <args>` and never throws for a non-zero exit. */
export type Docker = (args: ReadonlyArray<string>, options?: Readonly<{ input?: string; timeoutMs?: number }>) => Promise<DockerResult>

/** The label every bench object carries. */
export const BENCH_LABEL = 'delorun.bench=1'

/**
 * The real docker.
 * @param args - the arguments.
 * @param options - an optional standard input and a timeout.
 * @returns the output and exit status.
 */
export const realDocker: Docker = async (args, options = {}) => await new Promise((done) => {
  const child = execFile('docker', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 300_000 }, (error, stdout, stderr) => {
    const status = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
    done({ stdout, stderr, status })
  })
  if (options.input !== undefined) child.stdin?.end(options.input)
})

/**
 * Run docker and fail with its message on a non-zero exit.
 * @param docker - the docker function.
 * @param args - the arguments.
 * @param options - as for {@link Docker}.
 * @returns the standard output.
 */
export async function dockerOrThrow(docker: Docker, args: ReadonlyArray<string>, options?: Readonly<{ input?: string; timeoutMs?: number }>): Promise<string> {
  const result = await docker(args, options)
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (${result.status}): ${result.stderr.trim().slice(0, 400)}`)
  return result.stdout
}
