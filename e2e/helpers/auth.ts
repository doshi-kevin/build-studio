// Auth helpers for specs — loads per-role storageState so tests can skip
// the login form and go straight to the page they want to exercise.

import { test as base } from '@playwright/test'
import { storageStatePath, TEST_USERS, type TestUserRole } from '../fixtures/test-users'

/** Use this fixture when a test needs to run authenticated as a specific role. */
export function authedTest(role: TestUserRole) {
  return base.extend<{ storageStateFile: string }>({
    storageStateFile: [storageStatePath(role), { option: true }],
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `use` here is Playwright's fixture callback, not a React hook.
    storageState: ({ storageStateFile }, use) => use(storageStateFile),
  })
}

export { TEST_USERS }
