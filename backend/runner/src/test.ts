import { inject, it as base } from "vitest"

import { Resources } from "./testing/resources.js"

export { describe, expect } from "vitest"

declare module "vitest" {
  // eslint-disable-next-line typescript/consistent-type-definitions -- Only an interface merges with vitest's.
  export interface ProvidedContext {
    /** How long each of a test's cleanups may take, in milliseconds: a hook's time. */
    cleanupMs: number
  }
}

export const it = base.extend<{ resources: Resources }>({
  // eslint-disable-next-line no-empty-pattern -- Vitest reads destructuring to discover fixture dependencies.
  resources: async ({}, use) => {
    const resources = new Resources({ cleanupMs: inject("cleanupMs") })
    try {
      await use(resources)
    } finally {
      await resources.dispose()
    }
  },
})
