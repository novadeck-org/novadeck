import type { Harness } from "@novadeck/harness-core/harness"
import { filesWith } from "@novadeck/harness-pi/plugin"

import { ownProvider, ownProviderConfig, ownService, ownUnavailable } from "./model.js"

/** The model Nova runs on, as pi's extension registers it in Nova alone (`model.ts`). */
export const novaModel = {
  provider: ownProvider,
  variables: ownService,
  config: ownProviderConfig,
  unavailable: ownUnavailable,
} as const

/**
 * The pi adapter with Nova in it: its extension file (the one Nova's launcher loads too, beside
 * the person's pi) carries the model Nova runs on, which the extension registers only where its
 * launcher says it runs in Nova (`bundledMark`). Everything else is pi's: Nova is agent `pi`.
 */
export const withNova = (pi: Harness): Harness => ({ ...pi, files: filesWith(novaModel) })
