import { describe, expect, it } from "../../test"
import { clock, factsText, loadingText } from "./format"

describe("a video's time", () => {
  it("reads as a clock, with hours only once it has them", () => {
    expect(clock(7)).toBe("0:07")
    expect(clock(750)).toBe("12:30")
    expect(clock(3723)).toBe("1:02:03")
    expect(clock(Number.NaN)).toBe("0:00")
  })

  it("reads finely to the hundredth, so a frame's step shows", () => {
    expect(clock(0.75, true)).toBe("0:00.75")
    expect(clock(1 + 1 / 30, true)).toBe("0:01.03")
    expect(clock(62.5, true)).toBe("1:02.50")
    expect(clock(0.29, true)).toBe("0:00.29")
    expect(clock(59.999, true)).toBe("0:59.99")
  })
})

describe("a video's facts", () => {
  it("name its format and size, and how much of it has loaded", () => {
    expect(factsText("video/mp4", 12.3 * 1024 * 1024)).toBe("MP4 · 12.3 MB")
    expect(loadingText(24 * 1024, 79 * 1024)).toBe("Loading 24 of 79 KB")
    expect(loadingText(12 * 1024 * 1024, 40 * 1024 * 1024)).toBe("Loading 12 of 40 MB")
  })
})

describe("a recording's facts", () => {
  it("name its format as a person does", () => {
    expect(factsText("audio/mpeg", 4.2 * 1024 * 1024)).toBe("MP3 · 4.2 MB")
    expect(factsText("audio/x-wav", 900 * 1024)).toBe("WAV · 900 KB")
    expect(factsText("audio/x-m4a", 5 * 1024 * 1024)).toBe("M4A · 5.0 MB")
    expect(factsText("audio/x-speex", 1024 * 1024)).toBe("SPEEX · 1.0 MB")
  })
})
