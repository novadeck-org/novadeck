import type { Backend } from "@novadeck/core/port"
import { isDemoBundledPi } from "@novadeck/demo/bundled-pi"

import type { DemoActionGroup } from "./types"

const where = "Preferences > Experimental > Novadeck Agent (pi built in)"

// The states of Novadeck Agent's row, each put on the demo's at once (it needs the Experimental tab,
// which the experimental channel shows).
export const bundledPiGroups = (
  backend: Pick<Backend, "bundledPi">,
): readonly DemoActionGroup[] => {
  const pi = isDemoBundledPi(backend.bundledPi) ? backend.bundledPi : undefined
  if (!pi) return []
  return [
    {
      section: "App",
      title: "Novadeck Agent",
      actions: [
        {
          label: "Off",
          hint: `${where}: the switch off, no note under the description`,
          run: () => pi.show(false, { state: "off" }),
        },
        {
          label: "Downloading",
          hint: `${where}: the switch on, the note reads Downloading pi: 12.3 of 59.0 MB`,
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
          hint: `${where}: the switch on, the note in red reads Could not reach github.com. Check the connection., with Try again, which plays the download again`,
          run: () =>
            pi.show(true, {
              state: "failed",
              error: "Could not reach github.com. Check the connection.",
            }),
        },
      ],
    },
  ]
}
