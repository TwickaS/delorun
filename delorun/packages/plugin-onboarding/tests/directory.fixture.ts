import type { DirectoryEntry } from '../src/client/providers.ts'

/** The directory entries the providers specs use: DeepSeek, a catalog provider with a key page, one without, and a declared gateway. */
export const DIRECTORY: readonly DirectoryEntry[] = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], authEnv: ['DEEPSEEK_API_KEY'], baseURLEnv: [] },
  { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], defaultBaseURL: 'https://api.openai.com/v1', authEnv: ['OPENAI_API_KEY'], baseURLEnv: [] },
  { provider: 'typesafe', displayName: 'Typesafe', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'typesafe'], authEnv: ['TYPESAFE_API_KEY'], baseURLEnv: [] },
  { provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'], declared: true, authEnv: [], baseURLEnv: [] },
  { provider: 'azure', displayName: 'Azure', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'azure'], authEnv: ['AZURE_OPENAI_API_KEY'], baseURLEnv: ['AZURE_OPENAI_BASE_URL'] },
]
