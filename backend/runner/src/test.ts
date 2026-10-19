import { it as base } from "vitest"

import { Resources } from "./testing/resources.js"

export { describe, expect } from "vitest"

export const it = base.extend<{ resources: Resources }>({
  // eslint-disable-next-line no-empty-pattern -- Vitest reads destructuring to discover fixture dependencies.
  resources: async ({}, use) => {
    const resources = new Resources()
    try {
      await use(resources)
    } finally {
      await resources.dispose()
    }
  },
})
