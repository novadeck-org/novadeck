import type { Companions, ItemContent, FilePart } from "@novadeck/core/items"
import { workspaceReducer } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import type { PdfContent } from "@novadeck/viewers/pdf"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { createItemStore } from "../../store/item-store"
import { context, describe, expect, it } from "../../test"
import { pdf as registration } from "./index"

// jsdom runs no pdf.js: the viewer is a stand-in that notes the bytes it's given.
const drawn = vi.hoisted(() => [] as Blob[])
vi.mock("@novadeck/viewers/pdf", () => ({
  mountPdf: (element: HTMLElement, { content }: { content: PdfContent }) => {
    drawn.push(content.bytes)
    const marker = element.ownerDocument.createElement("div")
    marker.className = "pdf-stand-in"
    element.append(marker)
    return {
      update: (next: PdfContent) => drawn.push(next.bytes),
      state: () => ({}),
      restore: () => {},
      jumpTo: () => {},
      focus: () => {},
      zoom: () => {},
      destroy: () => marker.remove(),
    }
  },
}))

const unmounts: (() => void)[] = []
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  drawn.splice(0)
})

const target = { projectId: "project", workspaceSessionId: "initial" }
let ids = 0
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
const text = (blob: Blob) => blob.text()

// The PDF item in the pane, over a file the backend reads in parts of four bytes.
const shown = async ({
  file = "%PDF-1.4 report",
  stamp = "1",
  part,
  secret = false,
  id = `report${++ids}`,
}: {
  file?: string
  stamp?: string
  part?: Companions["part"] | null
  secret?: boolean
  id?: string
} = {}) => {
  const item = itemFixture(id, "01", {
    kind: "pdf",
    name: "report.pdf",
    path: "/p/report.pdf",
    secret,
  })
  let bytes = new TextEncoder().encode(file)
  const asked: { offset: number; reveal: string | undefined }[] = []
  const parts: Companions["part"] = async (_target, _id, { offset, reveal }) => {
    asked.push({ offset, reveal })
    return { state: "part", bytes: bytes.slice(offset, offset + 4) }
  }
  let emit: (content: ItemContent) => void = () => {}
  const ready = (at: string): ItemContent => ({
    state: "ready",
    stamp: at,
    content: { kind: "pdf", size: bytes.length },
  })
  const companions: Companions = {
    follow: (_target, _id, _options, on) => {
      emit = on
      on(ready(stamp))
      return () => {}
    },
    save: () => new Promise(() => {}),
    trouble: () => {},
    ...(part === null ? {} : { part: part ?? parts }),
  }
  const workspace = createWorkspaceStore(
    workspaceReducer(workspaceFixture(), { type: "item/upsert", target, item }),
  )
  const itemStore = createItemStore({ companions, workspace })
  unmounts.push(itemStore.connect())
  const view = () => createElement(registration.View, { item, itemStore, target })
  const rendered = render(view())
  unmounts.push(rendered.unmount)
  await settle()
  return {
    asked,
    container: rendered.container,
    unmount: rendered.unmount,
    // The pane shown again, as after a view switch.
    again: async () => {
      const next = render(view())
      unmounts.push(next.unmount)
      await settle()
      return next.container
    },
    // The file written again under a new stamp.
    rewrite: async (next: string, at = "2") => {
      bytes = new TextEncoder().encode(next)
      act(() => emit(ready(at)))
      await settle()
    },
  }
}

describe("a PDF in the pane", () => {
  it("reads its file in parts and draws it whole", async () => {
    const { asked, container } = await shown()
    await expect.poll(() => drawn.length).toBe(1)
    expect(asked.map(({ offset }) => offset)).toEqual([0, 4, 8, 12])
    expect(await text(drawn[0]!)).toBe("%PDF-1.4 report")
    expect(drawn[0]!.type).toBe("application/pdf")
    expect(container.querySelector(".pdf-stand-in")).not.toBeNull()
  })

  it("draws it again without reading it, shown again", async () => {
    const first = await shown({ id: "kept" })
    await expect.poll(() => drawn.length).toBe(1)
    first.unmount()
    const read = first.asked.length
    const container = await first.again()
    await expect.poll(() => drawn.length).toBe(2)
    expect(first.asked.length).toBe(read)
    expect(container.querySelector(".pdf-stand-in")).not.toBeNull()
  })

  it("keeps the old PDF in view while a rewritten one is read, then draws the new", async () => {
    const { container, rewrite } = await shown()
    await expect.poll(() => drawn.length).toBe(1)
    await rewrite("%PDF-1.4 revised report")
    await expect
      .poll(async () => drawn.length > 1 && (await text(drawn.at(-1)!)))
      .toBe("%PDF-1.4 revised report")
    expect(container.querySelector(".pdf-stand-in")).not.toBeNull()
  })

  it("reads a file that may hold secrets with no yes until the person gives it", async () => {
    const { asked } = await shown({ secret: true })
    await expect.poll(() => asked.length).toBeGreaterThan(0)
    expect(asked.every(({ reveal }) => reveal === undefined)).toBe(true)
  })

  context("when it can't be read", () => {
    it("says so where the backend reads no parts", async () => {
      const { container } = await shown({ part: null })
      expect(container.textContent).toContain("report.pdf can't be shown here.")
    })

    it("says so where a read fails", async () => {
      const { container } = await shown({ part: () => Promise.reject(new Error("gone")) })
      await expect.poll(() => container.textContent).toContain("report.pdf couldn't be loaded.")
    })

    it("says why where the runner refuses it", async () => {
      const refused = async (): Promise<FilePart> => ({ state: "unavailable", reason: "too-large" })
      const { container } = await shown({ part: refused })
      await expect
        .poll(() => container.textContent)
        .toContain("Novadeck previews PDFs up to 128 MB.")
    })
  })
})
