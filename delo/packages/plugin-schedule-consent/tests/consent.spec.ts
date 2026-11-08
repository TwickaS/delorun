/**
 * The consent's decision surface, without a composition: the approval naming and
 * the delivery review over the preset matrix. The same preset delivers; a chat
 * that moved to a wider preset refuses with its reason; the narrower, unnamed
 * and unreadable readings refuse with theirs; and a task and a chat without
 * presets deliver, as upstream does without a preset service.
 */
import { describe, expect, it } from 'vitest'
import type { ScheduleDeliveryReview, ScheduleEffect } from '@deepseek-ai/dsh-schedule'
import { ConfigSchema, nameConsentEffect, reviewConsentDelivery } from '../src/index.ts'

/** A stand-in Session: the review and the naming read only its id. */
const session = { id: 'chat-1' }

function effect(parts: Partial<ScheduleEffect>): ScheduleEffect {
  return { tool: 'schedule_create', recurrence: 'RRULE:FREQ=DAILY;COUNT=1', targetSessionId: undefined, targetPreset: undefined, ...parts }
}

function review(parts: Partial<ScheduleDeliveryReview>): ScheduleDeliveryReview {
  return { creationPreset: undefined, currentPreset: undefined, targetSessionId: session.id, ...parts }
}

describe('the delivery review', () => {
  it('delivers while the target chat still runs the approved preset', () => {
    expect(reviewConsentDelivery(review({ creationPreset: 'standard', currentPreset: 'standard' })))
      .toEqual({ kind: 'allow' })
  })

  it('refuses a chat that moved to a wider preset, with the reason', () => {
    expect(reviewConsentDelivery(review({ creationPreset: 'standard', currentPreset: 'full-access' })))
      .toEqual({
        kind: 'refuse',
        reason: 'the target chat moved from the "standard" permission preset to "full-access" after the task was approved',
      })
  })

  it('refuses a chat that moved to a narrower preset for the same reason shape', () => {
    expect(reviewConsentDelivery(review({ creationPreset: 'full-access', currentPreset: 'standard' })))
      .toEqual({
        kind: 'refuse',
        reason: 'the target chat moved from the "full-access" permission preset to "standard" after the task was approved',
      })
  })

  it('refuses a preset the approval did not name', () => {
    expect(reviewConsentDelivery(review({ creationPreset: undefined, currentPreset: 'standard' })))
      .toEqual({
        kind: 'refuse',
        reason: 'the target chat runs the "standard" permission preset, which the task\'s approval did not name',
      })
  })

  it('refuses a delivery whose preset cannot be read any more', () => {
    expect(reviewConsentDelivery(review({ creationPreset: 'standard', currentPreset: undefined })))
      .toEqual({
        kind: 'refuse',
        reason: 'the target chat\'s permission preset cannot be read to compare with the "standard" preset the task was approved under',
      })
  })

  it('delivers a task and a chat without presets, as upstream does', () => {
    expect(reviewConsentDelivery(review({})))
      .toEqual({ kind: 'allow' })
  })
})

describe('the approval naming', () => {
  it('names the recurrence, the target chat and its preset', () => {
    expect(nameConsentEffect(effect({ targetSessionId: session.id, targetPreset: 'standard' })))
      .toBe('The task delivers on "RRULE:FREQ=DAILY;COUNT=1" into the chat chat-1, which runs the standard permission preset.')
  })

  it('names the new chat a created target opens, with the inherited preset', () => {
    expect(nameConsentEffect(effect({ targetSessionId: undefined, targetPreset: 'standard' })))
      .toBe('The task delivers on "RRULE:FREQ=DAILY;COUNT=1" into a new chat that its first delivery opens, which runs the standard permission preset.')
  })

  it('names no preset while the deployment composes no preset roster', () => {
    expect(nameConsentEffect(effect({ targetSessionId: session.id, targetPreset: undefined })))
      .toBe('The task delivers on "RRULE:FREQ=DAILY;COUNT=1" into the chat chat-1.')
  })

  it('names nothing without a recurrence', () => {
    expect(nameConsentEffect(effect({ recurrence: '' })))
      .toBeUndefined()
  })
})

describe('the configuration schema', () => {
  it('defaults enabled to false, so a bare mount mounts nothing', () => {
    expect(ConfigSchema.parse({})).toEqual({ enabled: false })
    expect(ConfigSchema.parse(undefined)).toEqual({ enabled: false })
  })

  it('keeps an explicit value', () => {
    expect(ConfigSchema.parse({ enabled: true })).toEqual({ enabled: true })
  })
})
