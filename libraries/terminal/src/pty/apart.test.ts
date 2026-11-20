import { describe, expect, it } from "vitest"

import { listedApart, parseUtcLstart, sameProcess } from "./apart.js"
import type { Listed } from "./descendants.js"

const row = (pid: number, started: string, more: Partial<Listed> = {}): Listed => ({
  pid,
  parent: 1,
  group: pid,
  foreground: 0,
  started,
  zombie: false,
  ...more,
})

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")
// `ps -o lstart` under TZ=UTC, as Claude Code records it.
const utc = (at: Date) =>
  `${days[at.getUTCDay()]} ${months[at.getUTCMonth()]} ${at.getUTCDate()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} ${at.getUTCFullYear()}`

describe("a process its harness recorded", () => {
  it("is the listed one with the same clock ticks on Linux, and no other", () => {
    const apart = { pid: 42, start: "75822456" }
    expect(sameProcess(row(42, "75822456"), apart, "linux")).toBe(true)
    expect(sameProcess(row(42, "75822457"), apart, "linux")).toBe(false)
    expect(sameProcess(row(43, "75822456"), apart, "linux")).toBe(false)
    expect(sameProcess(row(42, "75822456", { zombie: true }), apart, "linux")).toBe(false)
  })

  it("is the listed one started the same second on macOS, its start given in UTC", () => {
    // The listing gives the local time.
    const local = new Date(2026, 10, 6, 15, 20, 11)
    const listed = row(42, "Fri Nov  6 15:20:11 2026")
    expect(sameProcess(listed, { pid: 42, start: utc(local) }, "darwin")).toBe(true)
    expect(sameProcess(listed, { pid: 42, start: "Fri Nov  6 15:20:11 2026" }, "darwin")).toBe(true)
    const later = new Date(local.getTime() + 1_000)
    expect(sameProcess(listed, { pid: 42, start: utc(later) }, "darwin")).toBe(false)
  })

  it("reads a UTC start as UTC, across the local clock's spring-forward gap too", () => {
    expect(parseUtcLstart("Sun Mar 29 01:30:00 2026")).toBe(Date.UTC(2026, 2, 29, 1, 30, 0))
    expect(parseUtcLstart("Sun Mar  8 02:30:00 2026")).toBe(Date.UTC(2026, 2, 8, 2, 30, 0))
    expect(parseUtcLstart("not a start")).toBeUndefined()
    expect(parseUtcLstart("Sun Foo 8 02:30:00 2026")).toBeUndefined()
  })

  it("is listed as found, by pid and the listing's own start", () => {
    const rows = [row(42, "100"), row(43, "200"), row(44, "300")]
    const apart = [
      { pid: 42, start: "100" },
      { pid: 44, start: "999" },
    ]
    expect(listedApart(rows, apart, "linux")).toEqual([{ pid: 42, started: "100" }])
  })
})
