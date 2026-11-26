import type { Backend } from "@novadeck/core/port"
import { isDemoBundledPi } from "@novadeck/demo/bundled-pi"

import type { DemoActionGroup } from "./types"

const where = "Preferences > Experimental > Nova"

// The states of Nova's row, each put on the demo's at once (it needs the Experimental tab,
// which the experimental channel shows).
export const bundledPiGroups = (
  backend: Pick<Backend, "bundledPi">,
): readonly DemoActionGroup[] => {
  const pi = isDemoBundledPi(backend.bundledPi) ? backend.bundledPi : undefined
  if (!pi) return []
  return [
    {
      section: "App",
      title: "Nova",
      actions: [
        {
          label: "Off",
          hint: `${where}: the switch off, no note under the description`,
          run: () => pi.show(false, { state: "off" }),
        },
        {
          label: "Starting",
          hint: `${where}: the switch on before the runner says anything, the note reads Starting the download…`,
          run: () => pi.show(true, { state: "off" }),
        },
        {
          label: "Downloading, size unknown",
          hint: `${where}: the switch on, the note reads Downloading Pi…`,
          run: () => pi.show(true, { state: "downloading" }),
        },
        {
          label: "Downloading",
          hint: `${where}: the switch on, the note reads Downloading Pi: 12.3 of 59.0 MB`,
          run: () =>
            pi.show(true, { state: "downloading", received: 12_345_678, size: 58_977_130 }),
        },
        {
          label: "Ready",
          hint: `${where}: the switch on, the note reads Ready.`,
          run: () => pi.show(true, { state: "ready" }),
        },
        {
          label: "Failed",
          hint: `${where}: the switch on, the note in red reads Couldn't reach github.com. Check your connection., with Try again, which plays the download again`,
          run: () =>
            pi.show(true, {
              state: "failed",
              error: "Couldn't reach github.com. Check your connection.",
            }),
        },
      ],
    },
  ]
}
