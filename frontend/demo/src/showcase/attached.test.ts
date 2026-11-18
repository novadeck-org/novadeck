import { describe, expect, it } from "../test"
import { attachedArtifact } from "./attached"

describe("a file the person opened that no agent showed", () => {
  it("is an image by the runner's image extensions, every JPEG one among them", () => {
    const images = ["a.png", "a.apng", "a.jpg", "a.JPEG", "a.jpe", "a.jfif", "a.pjpeg", "a.pjp"]
    const others = ["photo.jxl", "a.gif", "a.webp", "a.avif", "a.bmp", "a.ico", "a.cur", "a.svg"]
    for (const name of [...images, ...others])
      expect(attachedArtifact(`/p/${name}`).item.kind, name).toBe("image")
  })

  it("isn't one by a name that only starts like one", () => {
    for (const name of ["a.jp", "a.jpgx", "a.pj", "a.pngs", "a.heic", "a.tiff"])
      expect(attachedArtifact(`/p/${name}`).item.kind, name).not.toBe("image")
  })
})
