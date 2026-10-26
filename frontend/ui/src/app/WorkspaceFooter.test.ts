import type { Backend } from "@novadeck/core/port"
import { createTelemetryStore } from "@novadeck/core/telemetry"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { openCommands } from "../test/commands"
import { WorkspaceServicesContext } from "./controller/context"
import { noLanding } from "./inbox-landing"
import { WorkspaceFooter } from "./WorkspaceFooter"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
})

// The footer over real stores, with a backend that has only what the test gives it.
const show = (backend: Partial<Backend>): Rendered => {
  const { context, commands } = openCommands()
  const page = render(
    createElement(
      WorkspaceServicesContext,
      {
        value: {
          backend: { telemetry: createTelemetryStore(), ...backend } as Backend,
          workspace: context.workspace,
          ui: context.ui,
          chat: context.chat,
          navigation: context.navigation,
          commands,
          canvas: { current: null },
          itemStore: undefined,
          landing: noLanding,
          drag: undefined as never,
        },
      },
      createElement(WorkspaceFooter),
    ),
  )
  mounted.push(page)
  return page
}

const feedback: NonNullable<Backend["feedback"]> = {
  about: () => Promise.resolve({ version: "0.0.1", os: "Linux x64" }),
  send: () => Promise.resolve(),
  ask: () => Promise.resolve(),
}

describe("the footer's feedback button", () => {
  it("is there only where the backend takes feedback", () => {
    expect(show({}).container.querySelector(".feedback-button")).toBeNull()
    expect(show({ feedback }).container.querySelector(".feedback-button")).not.toBeNull()
  })
})
