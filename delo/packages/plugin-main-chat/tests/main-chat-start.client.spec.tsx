// @vitest-environment jsdom
import { brandString } from '@deepseek-ai/dsh-brand'
import { makeTranslate, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectBlankMainChat } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { MainChatStart } from '../src/client/MainChatStart.tsx'
import { MAIN_CHAT_SESSION_ID } from '../src/wire.ts'

afterEach(() => { cleanup() })

const MAIN = brandString<SessionId>(MAIN_CHAT_SESSION_ID)
const OTHER = brandString<SessionId>('a-chat-in-a-workspace')

describe('the main chat\'s first-message composer', () => {
  it('sends the trimmed message from the button and from Enter, and a new line from Shift+Enter', async () => {
    const send = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    render(<MainChatStart t={makeTranslate(en)} send={send} />)
    const input = screen.getByRole('textbox', { name: 'Message to the main chat' })
    const button = screen.getByRole('button', { name: 'Send message' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '  List my workspaces.  ' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('List my workspaces.')
    // While the message is on its way the composer neither edits nor sends it again.
    expect(input).toHaveProperty('readOnly', true)
    fireEvent.click(button)
    expect(send).toHaveBeenCalledTimes(1)
    cleanup()
    render(<MainChatStart t={makeTranslate(en)} send={send} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to the main chat' }), { target: { value: 'Start the notes.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(send).toHaveBeenLastCalledWith('Start the notes.') })
  })

  it('keeps the draft and says so when the message was refused, until it is edited', async () => {
    const send = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('refused')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<MainChatStart t={makeTranslate(en)} send={send} />)
    const input = screen.getByRole('textbox', { name: 'Message to the main chat' })
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect((await screen.findByRole('alert')).textContent).toBe('The message was not sent. Try again.')
    expect(input).toHaveProperty('value', 'Hello')
    expect(input).toHaveProperty('readOnly', false)
    expect(warn).toHaveBeenCalledTimes(1)
    fireEvent.change(input, { target: { value: 'Hello again' } })
    expect(screen.queryByRole('alert')).toBeNull()
    warn.mockRestore()
  })
})

describe('the composer\'s selector', () => {
  const blank = { ...sessionSnapshot(MAIN), blank: true }

  it('matches the main chat while nothing was asked of it', () => {
    expect(selectBlankMainChat({ sessionId: MAIN, session: blank, pendingInteraction: undefined })).toEqual({ blank: true })
  })

  it('leaves upstream\'s composer to another chat, a started main chat, and one with a prompt on its way', () => {
    expect(selectBlankMainChat({ sessionId: OTHER, session: { ...blank, sessionId: OTHER }, pendingInteraction: undefined })).toBeNull()
    expect(selectBlankMainChat({ sessionId: MAIN, session: undefined, pendingInteraction: undefined })).toBeNull()
    expect(selectBlankMainChat({ sessionId: MAIN, session: { ...blank, blank: false }, pendingInteraction: undefined })).toBeNull()
    expect(selectBlankMainChat({ sessionId: MAIN, session: { ...blank, awaitingFirstTurn: true }, pendingInteraction: undefined })).toBeNull()
    expect(selectBlankMainChat({ sessionId: MAIN, session: { ...blank, running: true }, pendingInteraction: undefined })).toBeNull()
    expect(selectBlankMainChat({ sessionId: MAIN, session: { ...blank, promptAttempted: true }, pendingInteraction: undefined })).toBeNull()
  })
})
