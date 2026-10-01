// Builds the two-tenant fixture once before the suite. Every file here reads it; none rebuild it.
import { beforeAll } from 'vitest'
import { seedFixture } from './fixture'

beforeAll(async () => {
  await seedFixture()
}, 120_000)
