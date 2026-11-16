/** `delorun devices`'s terminal question, over a recorded `@clack/prompts`. */
import { describe, expect, it, vi } from 'vitest'

const clack = vi.hoisted(() => ({
  CANCEL_SYMBOL: Symbol('cancel'),
  text: vi.fn(),
  isCancel: (value: unknown) => value === clack.CANCEL_SYMBOL,
}))

vi.mock('@clack/prompts', () => clack)

const { askInTerminal } = await import('../../src/devices/command.ts')

describe('the devices command\'s terminal question', () => {
  it('returns the typed answer, or nothing when the person cancels', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    clack.text.mockResolvedValueOnce('1234 5678')
    await expect(askInTerminal('Type the code')).resolves.toBe('1234 5678')
    expect(clack.text).toHaveBeenCalledWith({ message: 'Type the code' })
    clack.text.mockResolvedValueOnce(clack.CANCEL_SYMBOL)
    await expect(askInTerminal('Type the code')).resolves.toBeUndefined()
    Reflect.deleteProperty(process.stdin, 'isTTY')
  })
})
