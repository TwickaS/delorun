/**
 * What the journey reads from a Delorun home inside its container, with the container's own Node. It prints one JSON line.
 *
 * - `node home.mjs hash <path>...`: every file below each directory, or the file itself, with its SHA-256, and every
 *   symbolic link with its target, keyed by path; a missing path is an empty map.
 * - `node home.mjs stat <path>...`: as `hash`, with each file's size and modification time instead of its SHA-256,
 *   for trees too large to hash in a step.
 * - `node home.mjs find <directory> <text>`: the files below the directory whose content holds the text.
 * - `node home.mjs named <directory> <text>`: the files below the directory whose path holds the text.
 * - `node home.mjs studio <home>`: the newest studio address with its start token that the home's logs hold.
 * - `node home.mjs unit <storages directory> <unit name>`: the version in the header of the JSON storage unit of that
 *   name, or `null` when no file below the directory holds the unit.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every file and link below a directory.
 * @param directory - the directory.
 * @param into - the map to fill.
 * @returns the map.
 */
function walk(directory, into = {}, digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')) {
  if (!existsSync(directory)) return into
  if (!lstatSync(directory).isDirectory()) {
    into[directory] = digest(directory)
    return into
  }
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) into[path] = `link:${readlinkSync(path)}`
    else if (stat.isDirectory()) walk(path, into, digest)
    else into[path] = digest(path)
  }
  return into
}

const [action, ...args] = process.argv.slice(2)
let value
switch (action) {
  case 'hash':
    value = Object.assign({}, ...args.map(directory => walk(directory)))
    break
  case 'find':
    value = Object.keys(walk(args[0])).filter(path => !lstatSync(path).isSymbolicLink() && readFileSync(path, 'utf8').includes(args[1]))
    break
  case 'stat':
    value = Object.assign({}, ...args.map(directory => walk(directory, {}, (path) => {
      const stat = lstatSync(path)
      return `${String(stat.size)}:${String(stat.mtimeMs)}`
    })))
    break
  case 'named':
    value = Object.keys(walk(args[0])).filter(path => path.includes(args[1]))
    break
  case 'studio': {
    const files = Object.keys(walk(join(args[0], 'logs'))).filter(path => !lstatSync(path).isSymbolicLink()).sort((a, b) => lstatSync(a).mtimeMs - lstatSync(b).mtimeMs)
    const addresses = files.flatMap(path => [...readFileSync(path, 'utf8').matchAll(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/gu)].map(match => match[0]))
    value = addresses.at(-1) ?? null
    break
  }
  case 'unit': {
    const versions = Object.keys(walk(args[0])).filter(path => path.endsWith('.json') && !lstatSync(path).isSymbolicLink()).flatMap((path) => {
      try {
        const unit = JSON.parse(readFileSync(path, 'utf8')).unit
        return unit?.name === args[1] && typeof unit.version === 'number' ? [unit.version] : []
      } catch (_notJson) {
        // A JSON file that does not parse is not a storage unit.
        return []
      }
    })
    value = versions[0] ?? null
    break
  }
  default:
    process.stderr.write(`unknown action ${action}\n`)
    process.exit(2)
}
process.stdout.write(`${JSON.stringify(value)}\n`)
