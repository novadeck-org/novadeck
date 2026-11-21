import { hueOf } from "@novadeck/items/critters"

import { pageTheme as page } from "../theme/source"

// The page's theme as the runner backend draws its terminals with it: the page's tokens and
// theme changes, and the hue Messages draws an agent's handle in, for the rows the terminal
// draws of the doorbell's rings.
export const pageTheme = { ...page, hueOf }
