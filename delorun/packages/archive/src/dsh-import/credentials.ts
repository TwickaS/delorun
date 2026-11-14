/**
 * The credentials of a stock home: upstream's `.credentials.yaml`. Both the
 * stock document and the Delorun home's are read with upstream's own parser,
 * whose messages name a key and never a value. Only key material for the
 * provider Delorun's default profile mounts is offered: the `DEEPSEEK_API_KEY`
 * reference and the `key` of an `llm-deepseek` api-key record. An api-key
 * record's `env` map, which a provider may read as its endpoint or headers, and
 * every other reference and record are listed as not carried. The plan holds
 * the names only; the values are read again when the person has said yes,
 * written into the Delorun home's document beside the entries it already holds,
 * and never replace an entry it holds with another value. Nothing here prints,
 * logs or returns a value.
 *
 * @module @delorun/archive/dsh-import/credentials
 */
import { parseCredentialsDocument, type CredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { Document, parseDocument } from 'yaml'

/** The credentials document's home-relative path. */
export const CREDENTIALS_PATH = '.credentials.yaml'

/** The references the import offers: the key of the provider Delorun's default profile mounts. */
export const OFFERED_REFERENCES: readonly string[] = ['DEEPSEEK_API_KEY']

/** The record scopes whose api-key `key` the import offers. */
export const OFFERED_RECORD_SCOPES: readonly string[] = ['llm-deepseek']

/** What the import does with one stored credential. */
export type DshImportCredentialState = 'offered' | 'present' | 'taken' | 'not-carried'

/** One stored credential, by name. */
export interface DshImportCredential {
  /** The reference or record key, which names the credential and holds no part of it. */
  readonly name: string
  /** `offered` when the Delorun home holds none of that name, `present` when it holds the same key, `taken` when it holds another, `not-carried` for any credential the import does not offer. */
  readonly state: DshImportCredentialState
}

/**
 * Read one credentials document with upstream's parser.
 * @param text - the document's text.
 * @param label - how the parser's messages name the document.
 * @returns the parsed references and records.
 * @throws Error from upstream's parser, naming a key or a position and never a value.
 */
export function readCredentials(text: string, label: string): CredentialsDocument {
  return parseCredentialsDocument(text, label)
}

/**
 * The key material of one offered credential.
 * @param document - a parsed credentials document.
 * @param name - a reference or record key.
 * @returns the reference's value or the api-key record's `key`, or `undefined` when the import does not offer it.
 */
function keyMaterial(document: CredentialsDocument, name: string): string | undefined {
  if (OFFERED_REFERENCES.includes(name)) return document.refs.get(name)
  const record = document.records.get(name)
  const slash = name.indexOf('/')
  if (record?.kind !== 'api-key' || slash === -1 || !OFFERED_RECORD_SCOPES.includes(name.slice(0, slash))) return undefined
  return record.key
}

/**
 * Compare the stock credentials with the Delorun home's.
 * @param stock - the stock document.
 * @param delorun - the Delorun home's document, or `undefined` when it has none.
 * @returns every stock credential by name with its state, references first.
 */
export function compareCredentials(stock: CredentialsDocument, delorun: CredentialsDocument | undefined): DshImportCredential[] {
  return [...stock.refs.keys(), ...stock.records.keys()].map((name) => {
    const offered = keyMaterial(stock, name)
    if (offered === undefined) return { name, state: 'not-carried' as const }
    const held = delorun === undefined ? undefined : OFFERED_REFERENCES.includes(name) ? delorun.refs.get(name) : delorun.records.get(name)
    if (held === undefined) return { name, state: 'offered' as const }
    return { name, state: delorun !== undefined && keyMaterial(delorun, name) === offered ? 'present' as const : 'taken' as const }
  })
}

/**
 * Write the offered stock credentials into the Delorun home's document: a reference's value, and an api-key record with
 * its `key` alone.
 * @param stock - the stock document.
 * @param delorunText - the Delorun home's document text, or `undefined` when it has none.
 * @param names - the credentials to add, each one {@link compareCredentials} offered.
 * @returns the new document text: the Delorun home's document with each named entry added and every other entry as it was.
 */
export function mergeCredentials(stock: CredentialsDocument, delorunText: string | undefined, names: readonly string[]): string {
  const document = delorunText === undefined || delorunText.trim() === '' ? new Document({ version: 1 }) : parseDocument(delorunText)
  if (!document.has('version')) document.set('version', 1)
  for (const name of names) {
    const key = keyMaterial(stock, name) as string
    if (OFFERED_REFERENCES.includes(name)) document.setIn(['refs', name], key)
    else document.setIn(['records', name], document.createNode({ kind: 'api-key', key }))
  }
  return document.toString()
}
