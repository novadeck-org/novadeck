import type { Backend } from "../port"
import { contentDemo } from "./content"
import type { DemoSurfaceRuntime } from "./debug/types"
import { plainDemo, type PlainVariant } from "./index"

// The demos the content preview can run: the content showcase, and the plain ones.
export type DemoVariant = "showcase" | PlainVariant

export const demoVariants: readonly DemoVariant[] = [
  "showcase",
  "plain",
  "agents",
  "messages",
  "welcome",
]

export const createDemo = (variant: DemoVariant, runtime?: DemoSurfaceRuntime): Backend =>
  variant === "showcase" ? contentDemo(runtime) : plainDemo(variant, runtime)

const remembered = "novadeck.demo-variant"

const variantOf = (value: string | null | undefined): DemoVariant | undefined =>
  demoVariants.find((variant) => variant === value)

// The tab's storage, where a blocked or missing one remembers nothing.
const stored = (): string | null => {
  try {
    return window.sessionStorage.getItem(remembered)
  } catch {
    return null
  }
}

// The variant the address's hash asks for with `?demo=`, else the one the debug panel
// last chose in this tab, else the showcase. The tab keeps the choice because the router
// rewrites the address as soon as the app opens.
export const requestedVariant = (): DemoVariant => {
  const demo = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("demo")
  return variantOf(demo) ?? variantOf(stored()) ?? "showcase"
}

// Keeps the variant for the tab, so a reload boots it again after the router rewrote
// the address that asked for it.
export const keepVariant = (variant: DemoVariant): void => {
  try {
    window.sessionStorage.setItem(remembered, variant)
  } catch {
    // Without storage, the choice lasts until the page reloads.
  }
}

// Keeps the variant the debug panel chose, and puts the app back at its start page. The
// router does not hear it: the next boot reads the address afresh.
export const rememberVariant = (variant: DemoVariant): void => {
  keepVariant(variant)
  window.history.replaceState(null, "", "#/")
}
