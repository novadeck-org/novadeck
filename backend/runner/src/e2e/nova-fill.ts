// Fills the e2e cache with Nova's pinned release (nova-cache.ts), run through tsx by
// scripts/e2e/install/main.ts, which has the network, as the suite runs without any.
import { fillNovaCache } from "./nova-cache.js"

const { source } = await fillNovaCache()
console.log(`Nova: ${source}`)
