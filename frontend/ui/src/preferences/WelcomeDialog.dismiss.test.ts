import { render } from "@novadeck/test-kit/render"
import type { DialogProps } from "@novadeck/toolkit/Dialog"
import { createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "../test"
import { WelcomeDialog } from "./WelcomeDialog"

// The toolkit's dialog, stood in for to see what the welcome asks of it: that it never closes
// on Escape or a click outside (Ark would try, and `open` being controlled hides the
// difference in a rendered dialog), and that a close it is asked for finishes nothing.
const asked = vi.hoisted(() => ({ props: undefined as unknown }))
vi.mock("@novadeck/toolkit/Dialog", async (original) => {
  const real = await original<typeof import("@novadeck/toolkit/Dialog")>()
  return {
    ...real,
    Dialog: (props: DialogProps) => {
      asked.props = props
      return real.Dialog(props)
    },
  }
})

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

describe("the welcome dialog's dismissal", () => {
  it("is not closed by Escape or a click outside, and a close asked for finishes nothing", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {} }))
    const done = vi.fn<() => void>()
    const page = render(
      createElement(WelcomeDialog, { open: true, agents: [], onChange: () => {}, onDone: done }),
    )
    const props = asked.props as DialogProps
    expect(props.closeOnEscape).toBe(false)
    expect(props.closeOnInteractOutside).toBe(false)
    props.onOpenChange(false)
    expect(done).not.toHaveBeenCalled()
    page.unmount()
    vi.unstubAllGlobals()
  })
})
