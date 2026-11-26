// Fills the e2e cache with Novadeck's own pi's pinned release (own-pi-cache.ts), run through tsx by
// scripts/e2e/install/main.ts, which has the network, as the suite runs without any.
import { fillOwnPiCache } from "./own-pi-cache.js"

const { source } = await fillOwnPiCache()
console.log(`Novadeck's own pi: ${source}`)
