/**
 * The Cordis logger exporter: messages become records with Cordis's formatting, after key-name redaction of object
 * arguments and before text redaction, with an error argument as the record's `err`.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { attachCordisLogs, isDelorunLogger } from '../src/cordis.ts'
import { canary, openLog, recordsOf, tempHome, type TempHome } from './support.ts'

let context: Context | undefined
let temp: TempHome | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  temp?.remove()
  temp = undefined
})

describe('attachCordisLogs', () => {
  it('redacts object arguments by key name and registered values in the formatted message', async () => {
    const ctx = context = new Context()
    temp = tempHome()
    const { log, redactor, location } = openLog(temp.home)
    const value = canary('model-key')
    redactor.register(value, 'model-key')
    attachCordisLogs(ctx, log)
    ctx.logger('provider').warn('request failed %o with %s', { apiKey: 'plain-value', status: 401 }, value)
    ctx.logger('provider').error(new TypeError(`bad ${value}`))
    ctx.logger('provider').debug('detail %d', 3)
    const records = recordsOf(location.file)
    expect(records.map(record => record.msg)).toEqual([
      'request failed {"apiKey":"[redacted]","status":401} with [redacted:model-key]',
      'TypeError: bad [redacted:model-key]',
      'detail 3',
    ])
    expect(records[1]?.err).toMatchObject({ name: 'TypeError', message: 'bad [redacted:model-key]' })
    expect(JSON.stringify(records)).not.toContain('plain-value')
  })

  it('marks messages from Delorun\'s loggers as delorun and every other logger\'s as captured', () => {
    const ctx = context = new Context()
    temp = tempHome()
    const { log, location } = openLog(temp.home)
    attachCordisLogs(ctx, log)
    ctx.logger('delorun-home').info('mine')
    ctx.logger('@delorun/home-auth').info('mine too')
    ctx.logger('delorunner').info('not a Delorun name')
    ctx.logger('agent-loop').warn('upstream quoting a chat line')
    expect(recordsOf(location.file).map(record => [record.logger, record.source])).toEqual([
      ['delorun-home', 'delorun'],
      ['@delorun/home-auth', 'delorun'],
      ['delorunner', 'captured'],
      ['agent-loop', 'captured'],
    ])
    expect(isDelorunLogger('delorun')).toBe(true)
  })
})
