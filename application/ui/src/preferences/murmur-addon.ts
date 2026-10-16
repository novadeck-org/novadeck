import { formatSize } from "../model/addon-format"
import type { MurmurState } from "../model/murmur"

// What an installed murmur with no passed check says, beside Try again.
export const murmurUncheckedText =
  "Murmur is installed but has not passed its check on this computer yet."

// What the murmur card says, as plain functions of the addon's state.

export const murmurDescription = "Names your terminals from what they're doing, on this computer."

// What an install downloads: the engine and the model.
export const murmurInstallSize = ({ sizes }: MurmurState): number => sizes.engine + sizes.model

// The note under Install.
export const murmurDownloadNote = (state: MurmurState): string =>
  `Downloads ${formatSize(murmurInstallSize(state))} once, then works offline.`

// Where murmur runs, once a check has passed.
export const deviceText = ({ device }: NonNullable<MurmurState["check"]>): string =>
  `Runs on ${device}.`
