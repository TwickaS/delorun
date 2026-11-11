/** Finding values of secret-role fields in a row's config, a patch layer and a history version. */
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import {
  describeSecretValues,
  secretFieldAdmission,
  secretFieldsSet,
  secretValuesInPatch,
  secretValuesInVersion,
  type ConfigSchemasOf,
} from '../src/secrets.ts'

/** The Config of upstream's DeepSeek web plugins: a literal key, and the credential reference beside it. */
const WEB = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  baseURL: z.string().volatile(),
})

/** A Config with secret dictionary values, nested secrets and no reference field. */
const HEADERS = z.object({
  requestHeaders: z.dict(z.string().role('secret')).default({}),
  servers: z.array(z.object({ name: z.string(), token: z.string().role('secret') })).default([]),
})

const schemas: ConfigSchemasOf = (entryId) => {
  if (entryId === 'web-deepseek-api') return [WEB]
  if (entryId === 'headers') return [HEADERS, { not: 'a schema' }]
  return []
}

describe('secretFieldsSet', () => {
  it('names each secret field that holds a literal value, with the reference fields beside it', () => {
    expect(secretFieldsSet({ apiKey: 'sk-typed', baseURL: 'https://example.invalid' }, [WEB])).toEqual([
      { path: ['apiKey'], references: ['apiKeyEnv'] },
    ])
    expect(secretFieldsSet({ requestHeaders: { Authorization: 'Bearer x', Cookie: 'c' }, servers: [{ name: 'a' }, { name: 'b', token: 't' }] }, [HEADERS])).toEqual([
      { path: ['requestHeaders', 'Authorization'], references: [] },
      { path: ['requestHeaders', 'Cookie'], references: [] },
      { path: ['servers', '1', 'token'], references: [] },
    ])
  })

  it('finds nothing in a reference, an empty config, a `!!js` expression or a value that is not a schema', () => {
    expect(secretFieldsSet({ apiKeyEnv: 'MY_SEARCH_KEY' }, [WEB])).toEqual([])
    expect(secretFieldsSet(undefined, [WEB])).toEqual([])
    expect(secretFieldsSet({ apiKey: { __jsExpr: 'process.env.KEY' } }, [WEB])).toEqual([])
    expect(secretFieldsSet({ apiKey: 'sk-typed' }, [{ toJSON: 'no meta' }, undefined])).toEqual([])
  })
})

describe('secretValuesInPatch', () => {
  it('reads rows targeted by id, inserted rows and group rows, and names each place without the value', () => {
    const text = [
      '- id: web-deepseek-api',
      '  config:',
      '    apiKey: sk-typed-in-settings',
      '- insert:',
      '    - id: headers',
      '      name: headers-plugin',
      '      config:',
      '        requestHeaders: { Authorization: Bearer x }',
      '    - id: group',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: web-deepseek-api',
      '          config: { apiKey: sk-in-a-group }',
      '- id: unknown-row',
      '  config: { apiKey: not-a-loaded-plugin }',
      '- id: web-deepseek-api',
      '  disabled: true',
      '',
    ].join('\n')
    const places = secretValuesInPatch('cordis.patch.yml', text, schemas)
    expect(places).toEqual([
      { file: 'cordis.patch.yml', entryId: 'web-deepseek-api', path: ['apiKey'], references: ['apiKeyEnv'] },
      { file: 'cordis.patch.yml', entryId: 'headers', path: ['requestHeaders', 'Authorization'], references: [] },
      { file: 'cordis.patch.yml', entryId: 'web-deepseek-api', path: ['apiKey'], references: ['apiKeyEnv'] },
    ])
    const described = describeSecretValues(places)
    expect(described).toBe('cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead); cordis.patch.yml holds a value for the secret field requestHeaders.Authorization of headers; cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead)')
    expect(described).not.toContain('sk-')
  })

  it('admits a `!!js` expression, a reference and text that is not a patch list', () => {
    expect(secretValuesInPatch('p', '- id: web-deepseek-api\n  config:\n    apiKey: !!js process.env.SEARCH_KEY\n    apiKeyEnv: MY_SEARCH_KEY\n', schemas)).toEqual([])
    expect(secretValuesInPatch('p', '[]\n', schemas)).toEqual([])
    expect(secretValuesInPatch('p', '# only a comment\n', schemas)).toEqual([])
    expect(secretValuesInPatch('p', 'id: web-deepseek-api\n', schemas)).toEqual([])
    expect(secretValuesInPatch('p', '- 1\n- id: 2\n  config: { apiKey: x }\n', schemas)).toEqual([])
    expect(secretValuesInPatch('p', '- id: [unclosed\n', schemas)).toEqual([])
  })
})

describe('the history admission', () => {
  it('refuses a version whose profile patch or home patch copy holds a secret value, and admits one that holds none', () => {
    const admit = secretFieldAdmission(schemas)
    const secret = '- id: web-deepseek-api\n  config: { apiKey: sk-typed }\n'
    const reference = '- id: web-deepseek-api\n  config: { apiKeyEnv: MY_SEARCH_KEY }\n'
    expect(secretValuesInVersion(new Map([['cordis.patch.yml', reference], ['home-cordis.patch.yml', secret], ['package.json', secret]]), schemas)).toEqual([
      { file: 'home-cordis.patch.yml', entryId: 'web-deepseek-api', path: ['apiKey'], references: ['apiKeyEnv'] },
    ])
    const refusal = admit(new Map([['cordis.patch.yml', secret], ['home-cordis.patch.yml', undefined]]))
    expect(refusal).toBe('cordis.patch.yml holds a value for the secret field apiKey of web-deepseek-api (name a stored credential in apiKeyEnv instead). Delo keeps secrets out of patch files, which the profile history saves in git: store the value in the credentials file under a name, name it in the plugin\'s credential field, and delete the value from the patch')
    expect(admit(new Map([['cordis.patch.yml', reference], ['package.json', secret]]))).toBeUndefined()
    expect(admit(new Map())).toBeUndefined()
  })
})
