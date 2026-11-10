/**
 * The paths the studio's Devices section calls are the paths the Host registers: home-auth's device routes and the
 * reach service's status route. The browser half cannot import the Host packages, so this spec ties the two lists.
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_REMOVE_PATH, DEVICES_PATH, REACH_PATHS } from '@delo/home-auth'
import { REACH_STATUS_PATH } from '@delo/reach'
import { DEVICE_ROUTES } from '../src/client/devices-api.ts'

describe('the Devices section\'s routes', () => {
  it('are the routes the Host registers', () => {
    expect(DEVICE_ROUTES).toEqual({
      reachStatus: REACH_STATUS_PATH,
      devices: DEVICES_PATH,
      window: REACH_PATHS.window,
      pending: REACH_PATHS.pending,
      approve: REACH_PATHS.approve,
      remove: DEVICE_REMOVE_PATH,
    })
  })
})
