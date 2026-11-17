/**
 * The provider side of live agents: subagent providers, hand-off tools and the hiding of the one-shot tools.
 * @module @delorun/plugin-agent-seats/provider
 */
export { FULL_ACCESS_REASON, depthRefusal, gateRefusalSentence, handOffDescription } from './copy.ts'
export { hideOneShotTools, oneShotToolName, type HiddenOneShot } from './hide.ts'
export { SEAT_MODEL, isExternalAgentName, seatProvider, seatProviderName } from './provider.ts'
export { registerSeatProviders } from './register.ts'
export { handOffTool, type HandOffOptions } from './tool.ts'
