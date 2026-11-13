import { beforeEach, describe, expect, it, vi } from 'vitest'

const clack = vi.hoisted(() => ({
  CANCEL_SYMBOL: Symbol('cancel'),
  select: vi.fn(),
  autocomplete: vi.fn(),
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => value === clack.CANCEL_SYMBOL,
}))

vi.mock('@clack/prompts', () => clack)

const { SetupCancelled, terminalPrompter } = await import('../../src/setup/prompts.ts')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the terminal prompter', () => {
  it('draws a select with its hints and returns the choice', async () => {
    clack.select.mockResolvedValueOnce('b')
    const chosen = await terminalPrompter().select('Pick', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: 'hinted' }], 'a')
    expect(chosen).toBe('b')
    expect(clack.select).toHaveBeenCalledWith({ message: 'Pick', initialValue: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: 'hinted' }] })
  })

  it('draws a select of more than 15 choices, such as a provider\'s models, as a list to search', async () => {
    const options = Array.from({ length: 16 }, (_, index) => ({ value: `m${String(index)}`, label: `Model ${String(index)}` }))
    clack.autocomplete.mockResolvedValueOnce('m9')
    expect(await terminalPrompter().select('Model', options, 'm0')).toBe('m9')
    expect(clack.autocomplete).toHaveBeenCalledWith({ message: 'Model', initialValue: 'm0', options, maxItems: 12, placeholder: 'Type to search' })
    expect(clack.select).not.toHaveBeenCalled()
    clack.autocomplete.mockResolvedValueOnce(clack.CANCEL_SYMBOL)
    await expect(terminalPrompter().select('Model', options, 'm0')).rejects.toBeInstanceOf(SetupCancelled)
  })

  it('asks yes-or-no and shows notes', async () => {
    clack.confirm.mockResolvedValueOnce(false)
    expect(await terminalPrompter().confirm('Sure?', true)).toBe(false)
    expect(clack.confirm).toHaveBeenCalledWith({ message: 'Sure?', initialValue: true })
    terminalPrompter().note('body', 'Title')
    expect(clack.note).toHaveBeenCalledWith('body', 'Title')
  })

  it('refuses an empty key unless an empty entry is allowed', async () => {
    clack.password.mockResolvedValue('typed')
    expect(await terminalPrompter().secret('Key')).toBe('typed')
    const validate = (clack.password.mock.calls[0]?.[0] as { validate: (value: string | undefined) => string | undefined }).validate
    expect(validate('  ')).toBe('Enter a key.')
    expect(validate(undefined)).toBe('Enter a key.')
    expect(validate('k')).toBeUndefined()
    await terminalPrompter().secret('Key', true)
    const lenient = (clack.password.mock.calls[1]?.[0] as { validate: (value: string | undefined) => string | undefined }).validate
    expect(lenient('')).toBeUndefined()
  })

  it('checks a text entry, and skips the check for an empty one when allowed', async () => {
    clack.text.mockResolvedValue('value')
    const check = (value: string): string | undefined => (value === 'bad' ? 'not that' : undefined)
    expect(await terminalPrompter().text('Name', 'start', check)).toBe('value')
    expect(clack.text.mock.calls[0]?.[0]).toMatchObject({ message: 'Name', initialValue: 'start' })
    const strict = (clack.text.mock.calls[0]?.[0] as { validate: (value: string | undefined) => string | undefined }).validate
    expect(strict(' bad ')).toBe('not that')
    expect(strict(undefined)).toBeUndefined()
    await terminalPrompter().text('Name', 'start', () => 'always refused', true)
    const lenient = (clack.text.mock.calls[1]?.[0] as { validate: (value: string | undefined) => string | undefined }).validate
    expect(lenient('  ')).toBeUndefined()
    expect(lenient('x')).toBe('always refused')
  })

  it('turns a cancelled prompt into SetupCancelled', async () => {
    for (const method of [clack.select, clack.confirm, clack.password, clack.text]) method.mockResolvedValueOnce(clack.CANCEL_SYMBOL)
    const prompter = terminalPrompter()
    await expect(prompter.select('Pick', [], 'a')).rejects.toBeInstanceOf(SetupCancelled)
    await expect(prompter.confirm('Sure?', true)).rejects.toBeInstanceOf(SetupCancelled)
    await expect(prompter.secret('Key')).rejects.toBeInstanceOf(SetupCancelled)
    await expect(prompter.text('Name', '', () => undefined)).rejects.toThrow('Setup cancelled. Nothing was saved.')
  })
})

describe('setup in a terminal', () => {
  it('draws its questions with the terminal prompter when standard input is a terminal', async () => {
    const { runSetup } = await import('../../src/setup/index.ts')
    clack.select.mockResolvedValueOnce(clack.CANCEL_SYMBOL)
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    try {
      await expect(runSetup({ home: '/nonexistent-home', profile: 'default', env: {}, form: { kind: 'interactive' }, output: { stdout: () => undefined, stderr: () => undefined } })).rejects.toBeInstanceOf(SetupCancelled)
    } finally {
      Reflect.deleteProperty(process.stdin, 'isTTY')
    }
    expect(clack.select).toHaveBeenCalledTimes(1)
  })
})
