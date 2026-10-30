import { efforts, type Model } from "@novadeck/harness-core/harness"

/** Claude Code's model aliases, which it resolves to the latest model of each family. */
export const models: readonly Model[] = ["opus", "sonnet", "haiku", "fable"].map((alias) => ({
  id: alias,
  efforts,
}))
