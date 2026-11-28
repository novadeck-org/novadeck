import type { Harness } from "@novadeck/harness-core/harness"
import { filesWith } from "@novadeck/harness-pi/plugin"

import { novaProvider, novaProviderConfig, novaService, novaUnavailable } from "./model.js"

/** The models Nova runs on, as pi's extension registers it in Nova alone (`model.ts`). */
export const novaRegistration = {
  provider: novaProvider,
  variables: novaService,
  config: novaProviderConfig,
  unavailable: novaUnavailable,
} as const

/**
 * The pi adapter with Nova in it: its extension file (the one Nova's launcher loads too, beside
 * the person's pi) carries the model Nova runs on, which the extension registers only where its
 * launcher says it runs in Nova (`novaMark`). Everything else is pi's: Nova is agent `pi`.
 */
export const withNova = (pi: Harness): Harness => ({ ...pi, files: filesWith(novaRegistration) })
