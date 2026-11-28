import { pi } from "@novadeck/harness-pi/index"
import { describe, expect, it } from "vitest"

import { withNova } from "./extension.js"
import { novaProvider, novaService } from "./model.js"

const launchers = { mcp: { command: "/m", args: [] } } as never

// The extension's file as an adapter writes it.
const extension = (files: typeof pi.files): string => files?.("linux", launchers)[0]?.content ?? ""

describe("the pi adapter with Nova in it", () => {
  it("writes the extension with the model Nova runs on", () => {
    const written = extension(withNova(pi).files)
    expect(written).toContain(`"provider":"${novaProvider}"`)
    expect(written).toContain(novaService.baseUrl)
  })

  it("leaves the person's pi alone: pi's own adapter writes no model of Novadeck's", () => {
    expect(extension(pi.files)).not.toContain(novaService.baseUrl)
  })

  it("is pi in all else", () => {
    const nova = withNova(pi)
    expect(nova.id).toBe(pi.id)
    expect(nova.launch).toBe(pi.launch)
    expect(nova.shims).toBe(pi.shims)
  })
})
