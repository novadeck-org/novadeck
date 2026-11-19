import { commands } from "vitest/browser"

declare module "vitest/browser" {
  // Declaration merging extends Vitest's command registry.
  // eslint-disable-next-line typescript/consistent-type-definitions
  interface BrowserCommands {
    failFetches: (glob: string, failing: boolean) => Promise<void>
  }
}

/**
 * Fails the page's requests for what `glob` matches, as a part of the app that couldn't be
 * fetched, until `failing` is false again.
 */
export const failFetches = commands.failFetches
