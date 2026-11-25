/**
 * The `key` section of `delorun setup` (contract C11, "Model providers"): which model provider Delorun uses, where
 * its key comes from, and the model new chats start on. The section asks the provider, then for an
 * `openai-compatible` endpoint its base URL and model, then where the key comes from and, for a typed key, the key,
 * which one live request checks before it is stored. The model question follows for a provider without a default model in the
 * profile, which is every provider but DeepSeek; `delorun setup key` asks it of DeepSeek too. Each later question can
 * go back to the one before it. "Choose later" writes nothing, leaves the provider rows as they are, and says which model
 * new chats still start on and how to add a provider.
 *
 * @module @delorun/cli/setup/provider-section
 */
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { SETUP_DEFAULT_PROVIDER_ID, type ModelCredential, type ModelProviderAnswer } from '@delorun/contract-setup-answers'
import { CliError, EXIT } from '../exit.ts'
import { choiceNote, ENVIRONMENT_VARIABLE_LINE, RECOMMENDED } from './choices.ts'
import { baseURLProblem, baseURLWarning, modelIdProblem } from './answers.ts'
import type { KeyTarget } from './key-check.ts'
import { isSetupProviderId, profileModelSelection, PROVIDERS_BY_LABEL, SETUP_PROVIDERS, writeProviderRows, type ModelSelection, type ProviderCatalog, type SetupProvider } from './providers.ts'
import type { Draft, SectionAnswer, SectionEnvironment, SetupSection } from './sections.ts'
import { BACK, type Back, type StepIO } from './steps.ts'
import { hasStoredCredential, storeCredential } from './writes.ts'

/** The value of the provider question's "Choose later" choice; no provider id uses it. */
const NO_PROVIDER = 'none'

/** The value of the provider question's "More providers" choice; no provider id uses it. */
const MORE_PROVIDERS = 'more'

/**
 * What a run that sets up no provider prints: the model new chats still start on, which no answer changed, and how to
 * add a provider.
 * @param selection - the profile's model selection.
 * @returns the note.
 */
export function noProviderNote(selection: ModelSelection): string {
  const known = isSetupProviderId(selection.provider) ? SETUP_PROVIDERS[selection.provider] : undefined
  const key = known === undefined ? '' : `, which reads its key from ${known.keyVariable} unless the profile names another variable`
  return `No model provider was set up now, and no provider setting changed. New chats still start on ${selection.model} from ${known?.label ?? selection.provider}${key}. Add your model key in the studio (the first-run guide's Models step asks for it), or run delorun setup key (in a terminal, or with --provider <id> and its flags); Settings → Agent → Models adds a provider too.`
}

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
  /** True when the person kept the key saved in the home. */
  readonly keep?: boolean
}

/** The section's questions, in the order they can be asked. */
type Question = 'provider' | 'more-providers' | 'endpoint' | 'endpoint-model' | 'source' | 'key' | 'model' | 'done'

/**
 * Where a provider's key is checked.
 * @param provider - the provider.
 * @param baseURL - the endpoint the person gave, for `openai-compatible`.
 * @param catalog - the installed catalogues, for a catalog provider's endpoint.
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
 * Whether the model question is asked in a run.
 * @param provider - the provider.
 * @returns true for a provider whose models setup lists; an endpoint of the person's own names its model in its own question.
 */
function asksModel(provider: SetupProvider): boolean {
  return provider.adapter !== 'custom'
}

/**
 * The note above the key-source question: where to create a key, and what each way of giving it means.
 * @param provider - the provider.
 * @returns the note body.
 */
function keySourceNote(provider: SetupProvider): string {
  const where = provider.adapter === 'custom'
    ? 'Use the key your endpoint gives you.'
    : provider.keyPage === undefined ? `Create one in your ${provider.label} account.` : `Create one at ${provider.keyPage}`
  return [
    `${provider.label} needs an API key to answer. ${where}`,
    '',
    choiceNote([
      { label: 'Paste it now', lines: ['Delorun stores it in your Delorun folder, where only you can read it. The simplest choice.', 'Change later: delorun setup key.'] },
      { label: `Use ${provider.keyVariable}`, lines: [`For people who already set that variable in their shell. ${ENVIRONMENT_VARIABLE_LINE}`, 'Delorun reads it each time it starts.'] },
    ]),
  ].join('\n')
}

/**
 * The warning for a key variable that is empty in this terminal.
 * @param variable - the variable.
 * @returns the warning with the fix.
 */
function unsetVariableNote(variable: string): string {
  return `${variable} is not set in this terminal. Chats will not answer until you set it (for example, add export ${variable}=your-key to your shell profile) and then run delorun stop, then delorun start.`
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
 * The choice after a provider is picked.
 * @param next - the picked provider.
 * @param earlier - the earlier answer, whose endpoint, model and key source are offered again for the same provider.
 * @param draft - the run's answers, whose use case sets where the key comes from at first.
 * @param profileExists - whether the profile is set up already, which keeps the earlier answer's endpoint, model and key source for the same provider.
 * @returns the choice and the next question.
 */
function pickProvider(next: SetupProvider, earlier: ModelProviderAnswer | null, draft: Draft, profileExists: boolean): { readonly choice: Choice, readonly next: Question } {
  const kept = profileExists && earlier !== null && earlier.id === next.id ? earlier : undefined
  const fresh: ModelCredential = draft.answers.useCase === 'automation' ? { source: 'environment', name: next.keyVariable } : { source: 'prompt' }
  return {
    choice: { provider: next, baseURL: kept?.baseURL ?? null, model: kept?.model ?? null, credential: kept?.credential ?? fresh, secret: undefined, failure: undefined },
    next: next.adapter === 'custom' ? 'endpoint' : 'source',
  }
}

/**
 * Ask one question of the section.
 * @param question - the question.
 * @param io - the questions; the first one's go back to the previous section, later ones to the section's earlier question.
 * @param choice - the answers so far.
 * @param draft - the run's answers, for the mode and the earlier answer.
 * @param environment - what the section may look at.
 * @param catalog - the installed catalogues.
 * @returns the answers after the question and the next question, or {@link BACK}.
 */
async function ask(question: Exclude<Question, 'done'>, io: StepIO, choice: Choice, draft: Draft, environment: SectionEnvironment, catalog: ProviderCatalog): Promise<{ readonly choice: Choice, readonly next: Question } | Back> {
  const earlier = draft.answers.modelProvider
  const provider = choice.provider as SetupProvider
  const afterKey = (): Question => (asksModel(provider) ? 'model' : 'done')
  switch (question) {
    case 'provider': {
      io.note(choiceNote([
        { label: `${SETUP_PROVIDERS['deepseek-official'].label}${RECOMMENDED}`, lines: ['Delorun\'s default models, the ones it is tuned for.', 'Change later: delorun setup key.'] },
        { label: 'More providers', lines: ['Anthropic, OpenAI, Google Gemini and others, or any server that speaks the OpenAI API.'] },
        { label: 'Choose later', lines: ['The studio opens, but chats cannot answer until you run delorun setup key.'] },
      ]), 'Model provider')
      const initial = earlier === null ? NO_PROVIDER : earlier.id === SETUP_DEFAULT_PROVIDER_ID ? SETUP_DEFAULT_PROVIDER_ID : MORE_PROVIDERS
      const picked = await io.select('Which model provider should Delorun use?', [
        { value: SETUP_DEFAULT_PROVIDER_ID, label: `${SETUP_PROVIDERS[SETUP_DEFAULT_PROVIDER_ID].label}${RECOMMENDED}` },
        { value: MORE_PROVIDERS, label: 'More providers' },
        { value: NO_PROVIDER, label: 'Choose later' },
      ], initial)
      if (picked === BACK) return BACK
      if (picked === NO_PROVIDER) return { choice: { ...choice, provider: undefined }, next: 'done' }
      if (picked === MORE_PROVIDERS) return { choice, next: 'more-providers' }
      return pickProvider(SETUP_PROVIDERS[picked], earlier, draft, environment.profileExists)
    }
    case 'more-providers': {
      const others = PROVIDERS_BY_LABEL.filter(each => each.id !== SETUP_DEFAULT_PROVIDER_ID)
      const [first] = others as [SetupProvider, ...SetupProvider[]]
      const picked = await io.select('Which provider?', others.map(each => ({ value: each.id, label: each.label, hint: each.adapter === 'custom' ? 'a server that speaks OpenAI\'s Chat Completions API; asks its base URL and model' : undefined })), earlier !== null && earlier.id !== SETUP_DEFAULT_PROVIDER_ID ? earlier.id : first.id)
      return picked === BACK ? BACK : pickProvider(SETUP_PROVIDERS[picked], earlier, draft, environment.profileExists)
    }
    case 'endpoint': {
      const entered = await io.text('Base URL of the endpoint', choice.baseURL ?? '', baseURLProblem)
      if (entered === BACK) return BACK
      const baseURL = entered.trim()
      const warning = baseURLWarning(baseURL)
      if (warning !== undefined) io.note(warning, 'Plain http')
      return { choice: { ...choice, baseURL }, next: 'endpoint-model' }
    }
    case 'endpoint-model': {
      const entered = await io.text('Model id the endpoint serves', choice.model ?? '', modelIdProblem)
      return entered === BACK ? BACK : { choice: { ...choice, model: entered.trim() }, next: 'source' }
    }
    case 'source': {
      const automation = draft.answers.useCase === 'automation'
      io.note(keySourceNote(provider), `${provider.label} API key`)
      const saved = environment.profileExists && earlier?.id === provider.id && earlier.credential.source === 'prompt' && environment.hasSavedKey(provider.keyVariable)
      const source = await io.select(`How should Delorun get the ${provider.label} API key?`, [
        ...saved ? [{ value: 'keep', label: 'Keep the saved key' }] : [],
        { value: 'prompt', label: `Paste it now${automation ? '' : RECOMMENDED}` },
        { value: 'environment', label: `Use ${provider.keyVariable}${automation ? RECOMMENDED : ''}` },
      ], saved && choice.credential.source === 'prompt' ? 'keep' : choice.credential.source)
      if (source === BACK) return BACK
      if (source === 'keep') return { choice: { ...choice, credential: { source: 'prompt' }, secret: undefined, failure: undefined, keep: true }, next: afterKey() }
      if (source === 'prompt') return { choice: { ...choice, credential: { source: 'prompt' }, keep: false }, next: 'key' }
      const credential = { source: 'environment', name: provider.keyVariable } as const
      const value = environment.env[provider.keyVariable] ?? ''
      if (value === '') io.note(unsetVariableNote(provider.keyVariable), 'Key variable')
      if (environment.checkEnvironmentKey && value !== '') {
        const result = await environment.checkKey(keyTarget(provider, choice.baseURL, catalog), value)
        if (!result.ok) {
          io.note(`The key in ${provider.keyVariable} was not checked successfully: ${result.reason}`, 'Key check')
          return { choice: { ...choice, credential, secret: undefined, failure: result.reason, keep: false }, next: afterKey() }
        }
      }
      return { choice: { ...choice, credential, secret: undefined, failure: undefined, keep: false }, next: afterKey() }
    }
    case 'key': {
      const typed = await askTypedKey(io, provider, keyTarget(provider, choice.baseURL, catalog), environment)
      return typed === BACK ? BACK : { choice: { ...choice, secret: typed.key, failure: typed.failure, keep: false }, next: afterKey() }
    }
    case 'model': {
      const models = catalog.models(provider.id)
      const [first] = models
      if (first === undefined) throw new CliError(EXIT.failed, `delorun setup: the installed catalogue lists no model of ${provider.label}; set it up in the studio's Settings → Agent → Models`)
      const picked = await io.select(`Which ${provider.label} model should new chats start on?`, models.map(model => ({
        value: model.id, label: model.id, hint: model.name === model.id ? undefined : model.name,
      })), [choice.model, provider.defaultModel].find(candidate => models.some(model => model.id === candidate)) ?? first.id)
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
 * The section.
 * @param catalog - the installed catalogues, loaded when the section first needs them.
 * @returns the `key` section.
 */
export function providerSection(catalog: () => Promise<ProviderCatalog>): SetupSection {
  return {
    id: 'key',
    title: 'Model provider and key',
    inMainFlow: 'never',
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
        keepSavedKey: choice.keep === true,
        status: 'answered',
      }
    },
    unchanged: (before, after, typedKey) => !typedKey && isDeepStrictEqual(before.modelProvider, after.modelProvider),
    async apply(context, answers) {
      const answer = answers.modelProvider
      if (answer === null) return noProviderNote(profileModelSelection(join(context.directory, 'cordis.patch.yml'), 'delorun setup'))
      if (answer.credential.source === 'prompt' && !(context.secret === undefined && context.keepSavedKey === true && hasStoredCredential(context.home, SETUP_PROVIDERS[answer.id].keyVariable))) {
        if (context.secret === undefined) throw new CliError(EXIT.failed, 'delorun setup: the model key was not entered; run delorun setup in a terminal to finish')
        await storeCredential(context.home, SETUP_PROVIDERS[answer.id].keyVariable, context.secret)
      }
      writeProviderRows(join(context.directory, 'cordis.patch.yml'), answer)
      return undefined
    },
  }
}
