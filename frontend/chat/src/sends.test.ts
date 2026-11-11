import { afterEach, vi } from "vitest"

import type { Attachment } from "./attachments"
import { keepRecordedImages, recordedImagesOf } from "./sends"
import { describe, expect, it } from "./test"

const image = (name: string): Attachment => ({
  id: name,
  n: 1,
  name,
  preview: `blob:${name}`,
  state: "ready",
  path: `/up/${name}`,
  error: null,
})

afterEach(() => Reflect.deleteProperty(URL, "revokeObjectURL"))

describe("the images of prompts the record holds", () => {
  it("stay by the prompt's ref for its thumbnails", () => {
    keepRecordedImages("recorded-a", [image("a")])
    expect(recordedImagesOf("recorded-a")?.map(({ name }) => name)).toEqual(["a"])
    expect(recordedImagesOf("recorded-none")).toBeUndefined()
    keepRecordedImages("recorded-empty", [])
    expect(recordedImagesOf("recorded-empty")).toBeUndefined()
  })

  it("are the latest few, the oldest's previews let go as it leaves", () => {
    const revoke = vi.fn<(url: string) => void>()
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true })
    for (let each = 0; each < 17; each += 1) keepRecordedImages(`ring-${each}`, [image(`p${each}`)])
    expect(recordedImagesOf("ring-0")).toBeUndefined()
    expect(recordedImagesOf("ring-16")).toBeDefined()
    expect(revoke).toHaveBeenCalledWith("blob:p0")
  })
})
