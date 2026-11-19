/**
 * The model a person picked for each workspace's agent (EA22), kept in a JSON file of Delorun's own folder. Nothing is
 * written under the program's own home (`~/.codex`, `~/.claude`).
 * @module @delorun/plugin-agent-seats/state/choices
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SeatModelChoices } from '../adapter/state-port.ts'

/** The file's name inside the folder given to {@link loadModelChoices}. */
export const MODEL_CHOICES_FILE = 'agent-seat-models.json'

/** The choices of this Delorun, which a pick changes and persists. */
export class FileModelChoices implements SeatModelChoices {
  private readonly choices: Map<string, string>
  private readonly path: string
  private readonly failed: (error: unknown) => void
  private writing: Promise<void> = Promise.resolve()

  /**
   * @param path - the JSON file to keep the choices in.
   * @param choices - the choices read from it.
   * @param failed - told when a write fails; the choice stays in memory for this run.
   */
  constructor(path: string, choices: Map<string, string>, failed: (error: unknown) => void) {
    this.path = path
    this.choices = choices
    this.failed = failed
  }

  get(workspace: string): string | undefined {
    return this.choices.get(workspace)
  }

  set(workspace: string, id: string): void {
    this.choices.set(workspace, id)
    const body = `${JSON.stringify(Object.fromEntries(this.choices), null, 2)}\n`
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, body, { mode: 0o600 })
      await rename(temporary, this.path)
    }).catch(this.failed)
  }

  /** @returns resolves once every pick so far is on disk (or its write failed). */
  settled(): Promise<void> {
    return this.writing
  }
}

/**
 * Read the choices file.
 * @param path - the JSON file; a missing file holds no choices.
 * @param failed - told when a later write fails.
 * @returns the choices.
 * @throws when the file exists and is not an object of strings: the person's picks would be lost silently otherwise.
 */
export async function loadModelChoices(path: string, failed: (error: unknown) => void): Promise<FileModelChoices> {
  let body: string
  try {
    body = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new FileModelChoices(path, new Map(), failed)
    throw error
  }
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object of workspace keys and model ids`)
  const choices = new Map<string, string>()
  for (const [workspace, id] of Object.entries(parsed)) {
    if (typeof id !== 'string') throw new Error(`${path}: the model for ${workspace} must be a string`)
    choices.set(workspace, id)
  }
  return new FileModelChoices(path, choices, failed)
}
