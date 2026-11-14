/** Delorun's repository guard read back to upstream's workflow text, and refused when it is missing. */
import { describe, expect, it } from 'vitest'
import { REPOSITORY_GUARD, upstreamCondition, upstreamRunsOn } from './delorun-repository-guard.ts'

describe('Delorun repository guard', () => {
  it('returns the condition upstream wrote, in its own form', () => {
    expect(upstreamCondition(REPOSITORY_GUARD)).toBeUndefined()
    expect(upstreamCondition(`${REPOSITORY_GUARD} && (inputs.publish)`)).toBe('inputs.publish')
    expect(upstreamCondition(`\${{ ${REPOSITORY_GUARD} && (!cancelled() && github.event_name == 'pull_request') }}`))
      .toBe("${{ !cancelled() && github.event_name == 'pull_request' }}")
    expect(upstreamCondition(`${REPOSITORY_GUARD} && ( (a || b)\n  && c\n)`)).toBe('(a || b)\n  && c')
  })

  it('refuses a condition without the guard', () => {
    for (const condition of [undefined, 'inputs.publish', `inputs.publish && ${REPOSITORY_GUARD}`, `${REPOSITORY_GUARD} || (inputs.publish)`]) {
      expect(() => upstreamCondition(condition)).toThrow('lacks Delorun\'s repository guard')
    }
  })

  it('returns the runner selector upstream wrote and checks the hosted label', () => {
    const routed = `\${{ ${REPOSITORY_GUARD} && (\n    vars.X == 'blacksmith' && 'blacksmith-4vcpu-ubuntu-2404'\n    || 'dsh-ubuntu-24-04-16core'\n) || 'ubuntu-latest' }}\n`
    expect(upstreamRunsOn(routed, 'ubuntu-latest')).toBe("${{ vars.X == 'blacksmith' && 'blacksmith-4vcpu-ubuntu-2404'\n    || 'dsh-ubuntu-24-04-16core' }}")
    expect(() => upstreamRunsOn(routed, 'windows-latest')).toThrow('lacks Delorun\'s routing to windows-latest')
    expect(() => upstreamRunsOn("${{ vars.X == 'blacksmith' && 'blacksmith-4vcpu-ubuntu-2404' || 'ubuntu-latest' }}", 'ubuntu-latest')).toThrow('lacks Delorun\'s routing')
  })
})
