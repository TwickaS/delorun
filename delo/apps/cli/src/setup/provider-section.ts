/**
 * The `key` section of `delorun setup` (contract C11, "Model providers"): which model provider Delorun uses, where
 * its key comes from, and the model new chats start on. Quick and Full ask the provider, then for an
 * `openai-compatible` endpoint its base URL and model, then where the key comes from and, for a typed key, the key,
 * which one live request checks before it is stored. Full then asks the model of every provider; Quick asks it only
 * of a provider without a default model in the profile, which is every provider but DeepSeek. Each later question can
 * go back to the one before it. "None for now" writes nothing and says how to add a provider.
 *
 * @module @delo/cli/setup/provider-section
 */
import { join } from 'node:path'
import type { ModelCredential, ModelProviderAnswer, SetupAnswers } from '@delo/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'
import { baseURLProblem } from './answers.ts'
import type { KeyTarget } from './key-check.ts'
import { PROVIDERS_BY_LABEL, SETUP_PROVIDERS, writeProviderRows, type ProviderCatalog, type SetupProvider } from './providers.ts'
import type { Draft, SectionAnswer, SectionEnvironment, SetupSection } from './sections.ts'
import { BACK, type Back, type StepIO } from './steps.ts'
import { storeCredential } from './writes.ts'

/** The value of the provider question's "None for now" choice; no provider id uses it. */
const NO_PROVIDER = 'none'

/** What a run without a provider prints: how to add one, and what new chats use until then. */
export const NO_PROVIDER_NOTE = 'No model provider is set up. Choose one with delorun setup key, in a terminal or with --provider <id> and its flags; the studio\'s Settings → Models adds one too. Until then new chats start on the profile\'s default model, DeepSeek\'s, which reads its key from DEEPSEEK_API_KEY.'

/** The section's answers while it asks. */
interface Choice {
  /** The provider, or `undefined` for none. */
  readonly provider: SetupProvider | undefined
  readonly baseURL: string | null
  readonly model: string | null
  readonly credential: ModelCredential
  /** The typed key. */
  readonly secret: string | undefined
  /** Why the key's check failed when the person continued without a successful one. */
  readonly failure: string | undefined
}

/** The section's questions, in the order they can be asked. */
type Question = 'provider' | 'endpoint' | 'endpoint-model' | 'source' | 'key' | 'model' | 'done'

/**
 * Where a provider's key is checked.
 * @param provider - the provider.
 * @param baseURL - the endpoint the person gave, for `openai-compatible`.
 * @param catalog - the installed catalogs, for a catalog provider's endpoint.
 * @returns the key check's target.
 */
export function keyTarget(provider: SetupProvider, baseURL: string | null, catalog: ProviderCatalog): KeyTarget {
  switch (provider.adapter) {
    case 'deepseek': return { provider, baseURL: undefined }
    case 'catalog': return { provider, baseURL: catalog.baseURL(provider.id) }
    case 'custom': return { provider, baseURL: baseURL ?? undefined }
  }
}

/**
 * Whether the model question is asked in a run of a mode.
 * @param provider - the provider.
 * @param mode - the run's mode.
 * @returns true in Full for a provider whose models setup lists, and in Quick for one without a default model.
 */
function asksModel(provider: SetupProvider, mode: Draft['mode']): boolean {
  if (provider.adapter === 'custom') return false
  return mode === 'full' || provider.adapter === 'catalog'
}

/**
 * Ask the key, and on a failed check say why and let the person enter it again or continue.
 * @param io - the questions.
 * @param provider - the provider.
 * @param target - where the key is checked.
 * @param environment - what the section may look at.
 * @returns the key with the reason its check failed when the person continued anyway, or {@link BACK}.
 */
async function askTypedKey(io: StepIO, provider: SetupProvider, target: KeyTarget, environment: SectionEnvironment): Promise<{ readonly key: string, readonly failure?: string } | Back> {
  for (;;) {
    const key = await io.secret(`${provider.label} API key`)
    if (key === BACK) return BACK
    const result = await environment.checkKey(target, key)
    if (result.ok) return { key }
    io.note(`The key was not checked successfully: ${result.reason}\nA wrong key means the model cannot answer; you can change it later with delorun setup key.`, 'Key check')
    const next = await io.followUp().select('What now?', [
      { value: 'again', label: 'Enter the key again' },
      { value: 'continue', label: 'Continue without a successful check' },
    ], 'again')
    if (next === BACK) return BACK
    if (next === 'continue') return { key, failure: result.reason }
  }
}

/**
 * Ask one question of the section.
 * @param question - the question.
 * @param io - the questions; the first one's go back to the previous section, later ones to the section's earlier question.
 * @param choice - the answers so far.
 * @param draft - the run's answers, for the mode and the earlier answer.
 * @param environment - what the section may look at.
 * @param catalog - the installed catalogs.
 * @returns the answers after the question and the next question, or {@link BACK}.
 */
async function ask(question: Exclude<Question, 'done'>, io: StepIO, choice: Choice, draft: Draft, environment: SectionEnvironment, catalog: ProviderCatalog): Promise<{ readonly choice: Choice, readonly next: Question } | Back> {
  const earlier = draft.answers.modelProvider
  const provider = choice.provider as SetupProvider
  const afterKey = (): Question => (asksModel(provider, draft.mode) ? 'model' : 'done')
  switch (question) {
    case 'provider': {
      const picked = await io.select('Which model provider should Delorun use?', [
        ...PROVIDERS_BY_LABEL.map(each => ({ value: each.id, label: each.label, hint: each.adapter === 'custom' ? 'a server that speaks OpenAI\'s Chat Completions API; asks its base URL and model' : undefined })),
        { value: NO_PROVIDER, label: 'None for now', hint: 'add one later with delorun setup key or in the studio\'s Settings → Models' },
      ], earlier?.id ?? NO_PROVIDER)
      if (picked === BACK) return BACK
      if (picked === NO_PROVIDER) return { choice: { ...choice, provider: undefined }, next: 'done' }
      const next = SETUP_PROVIDERS[picked]
      // The earlier answer's endpoint, model and key source are offered again only for the same provider.
      const kept = earlier !== null && earlier.id === next.id ? earlier : undefined
      return {
        choice: { provider: next, baseURL: kept?.baseURL ?? null, model: kept?.model ?? null, credential: kept?.credential ?? { source: 'prompt' }, secret: undefined, failure: undefined },
        next: next.adapter === 'custom' ? 'endpoint' : 'source',
      }
    }
    case 'endpoint': {
      const entered = await io.text('Base URL of the endpoint', choice.baseURL ?? '', baseURLProblem)
      return entered === BACK ? BACK : { choice: { ...choice, baseURL: entered.trim() }, next: 'endpoint-model' }
    }
    case 'endpoint-model': {
      const entered = await io.text('Model id the endpoint serves', choice.model ?? '', value => (value === '' ? 'Enter the model id.' : undefined))
      return entered === BACK ? BACK : { choice: { ...choice, model: entered.trim() }, next: 'source' }
    }
    case 'source': {
      const source = await io.select(`Where does the ${provider.label} API key come from?`, [
        { value: 'prompt', label: 'Enter the key now', hint: 'stored in the home\'s credentials document' },
        { value: 'environment', label: `Read ${provider.keyVariable} from the environment at each start` },
      ], choice.credential.source)
      if (source === BACK) return BACK
      if (source === 'prompt') return { choice: { ...choice, credential: { source: 'prompt' } }, next: 'key' }
      const credential = { source: 'environment', name: provider.keyVariable } as const
      const value = environment.env[provider.keyVariable] ?? ''
      if (environment.checkEnvironmentKey && value !== '') {
        const result = await environment.checkKey(keyTarget(provider, choice.baseURL, catalog), value)
        if (!result.ok) {
          io.note(`The key in ${provider.keyVariable} was not checked successfully: ${result.reason}`, 'Key check')
          return { choice: { ...choice, credential, secret: undefined, failure: result.reason }, next: afterKey() }
        }
      }
      return { choice: { ...choice, credential, secret: undefined, failure: undefined }, next: afterKey() }
    }
    case 'key': {
      const typed = await askTypedKey(io, provider, keyTarget(provider, choice.baseURL, catalog), environment)
      return typed === BACK ? BACK : { choice: { ...choice, secret: typed.key, failure: typed.failure }, next: afterKey() }
    }
    case 'model': {
      const models = catalog.models(provider.id)
      const [first] = models
      if (first === undefined) throw new CliError(EXIT.failed, `delorun setup: the installed catalog lists no model of ${provider.label}; set it up in the studio's Settings → Models`)
      const picked = await io.select(`Which ${provider.label} model should new chats start on?`, models.map(model => ({
        value: model.id, label: model.id, hint: model.name === model.id ? undefined : model.name,
      })), models.some(model => model.id === choice.model) ? choice.model as string : first.id)
      return picked === BACK ? BACK : { choice: { ...choice, model: picked }, next: 'done' }
    }
  }
}

/**
 * The provider answer of a finished choice.
 * @param choice - the section's answers.
 * @returns the answer, or `null` for none.
 */
function answerOf(choice: Choice): ModelProviderAnswer | null {
  if (choice.provider === undefined) return null
  return { id: choice.provider.id, credential: choice.credential, baseURL: choice.baseURL, model: choice.model }
}

/**
 * The review line's description of a key.
 * @param answer - the provider answer.
 * @returns where the key comes from.
 */
function keySource(answer: ModelProviderAnswer): string {
  return answer.credential.source === 'prompt' ? 'key entered now' : `key read from ${answer.credential.name} at each start`
}

/**
 * The section.
 * @param catalog - the installed catalogs, loaded when the section first needs them.
 * @returns the `key` section.
 */
export function providerSection(catalog: () => Promise<ProviderCatalog>): SetupSection {
  return {
    id: 'key',
    title: 'Model provider and key',
    mode: 'quick',
    asks: () => true,
    appliesTo: () => true,
    async ask(io, draft, environment): Promise<SectionAnswer | Back> {
      const catalogue = await catalog()
      const history: { readonly question: Question, readonly choice: Choice }[] = []
      let question: Question = 'provider'
      let choice: Choice = { provider: undefined, baseURL: null, model: null, credential: { source: 'prompt' }, secret: undefined, failure: undefined }
      while (question !== 'done') {
        const asked = await ask(question, history.length === 0 ? io : io.followUp(), choice, draft, environment, catalogue)
        if (asked === BACK) {
          const previous = history.pop()
          if (previous === undefined) return BACK
          question = previous.question
          choice = previous.choice
          continue
        }
        history.push({ question, choice })
        question = asked.next
        choice = asked.choice
      }
      return {
        answers: { modelProvider: answerOf(choice) },
        ...choice.secret === undefined ? {} : { secret: choice.secret },
        ...choice.failure === undefined ? {} : { keyCheckFailure: choice.failure },
        status: 'answered',
      }
    },
    review(answers: SetupAnswers, draft?: Draft) {
      const answer = answers.modelProvider
      if (answer === null) return 'Model provider: none for now; add one later with delorun setup key'
      const provider = SETUP_PROVIDERS[answer.id]
      const endpoint = answer.baseURL === null ? '' : ` at ${answer.baseURL}`
      const model = answer.model === null ? 'the profile\'s default model' : `model ${answer.model}`
      return `Model provider: ${provider.label}${endpoint}, ${model}, ${keySource(answer)}${draft?.keyCheckFailure === undefined ? '' : `, not verified: ${draft.keyCheckFailure}`}`
    },
    async apply(context, answers) {
      const answer = answers.modelProvider
      if (answer === null) return NO_PROVIDER_NOTE
      if (answer.credential.source === 'prompt') {
        if (context.secret === undefined) throw new CliError(EXIT.failed, 'delorun setup: the model key was not entered; run delorun setup in a terminal to finish')
        await storeCredential(context.home, SETUP_PROVIDERS[answer.id].keyVariable, context.secret)
      }
      writeProviderRows(join(context.directory, 'cordis.patch.yml'), answer)
      return undefined
    },
  }
}
