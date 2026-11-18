import { AudioLines } from "lucide-react"

import { artifactLook, artifactThumb, artifactView } from "../../ArtifactViewer"
import type { ItemRegistration } from "../../registration"
import { AudioThumb, AudioViewer } from "./AudioViewer"

// A recording an agent showed, played on a card with its waveform.
export const audio = {
  kind: "audio",
  names: { one: "recording", many: "Recordings" },
  icon: () => AudioLines,
  stackIcon: AudioLines,
  look: artifactLook,
  Thumb: artifactThumb("audio", AudioThumb),
  View: artifactView("audio", AudioViewer),
} satisfies ItemRegistration<"audio">
