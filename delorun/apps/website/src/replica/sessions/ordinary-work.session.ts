/**
 * STAND-IN, hand-made: "a piece of ordinary work", the hero's session. A person asks how many tests a project has; the
 * agent asks before it runs the test command; the person allows it once; the agent answers. Stage 3 replaces this file
 * with a fixture made from a real run on the opening candidate. The rows follow the wire form of a recorded session
 * (`snapshots/web/approval-composer/session.v4.jsonl`), so the product's own transcript can render them in the parity test.
 * @module @delorun/website/replica/sessions/ordinary-work.session
 */
import type { ReplicaFixture } from '../model.ts'

/** The session. */
export const FIXTURE: ReplicaFixture = {
  id: 'ordinary-work',
  standIn: true,
  release: '0.1.0-preview.1.6',
  clock: '2026-11-17T10:50:00Z',
  events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'message-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'How many tests does this project have, and do they pass?' }] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'message-2', role: 'assistant', content: [{ type: 'text', text: 'I will run the test suite and count the results.' }] } } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pnpm test"}' } },
    { type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash', callId: 'call-1', reason: 'Run the test suite to count the tests and see whether they pass.', escalatesTo: 'workspace-write' } },
    { type: 'approval/decided', data: { id: 'approval-1', outcome: 'allowed-once' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'message-3', role: 'tool', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: ' Test Files  31 passed (31)\n      Tests  214 passed (214)\n   Duration  4.21s' }] } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'assistant/message', data: { turn: 1, step: 2, message: { id: 'message-4', role: 'assistant', content: [{ type: 'text', text: 'The project has 214 tests in 31 files, and all of them pass. The run took about four seconds.' }] } } },
    { type: 'step/end', data: { turn: 1, step: 2 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  changes: {},
  versions: {},
}
