/**
 * Setup for Delorun's client component specs (the `fork-client` project of `delorun/vitest.config.ts`): Testing Library's
 * wait for `findBy*` and `waitFor` is 5 s instead of its default of 1 s, so a render that a busy machine delays is
 * still found. It stays well below the project's 30 s test budget, so a missing element reports Testing Library's own
 * message, which names the query, before the test times out.
 */
import { configure } from '@testing-library/dom'

configure({ asyncUtilTimeout: 5_000 })
