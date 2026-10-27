/* eslint-disable no-await-in-loop -- Each case runs on its own, one after another. */
import { describe, expect, it } from "../test"
import {
  leaveForNewerPortable,
  parsePortableRecord,
  recordPortableCopy,
  type HandoffCheck,
  type RecordHost,
} from "./portable-handoff"

const record = (path: string, version: string, extra: object = {}): string =>
  JSON.stringify({ path, version, ...extra })

describe("a portable copy's record", () => {
  it("reads a path and a version", () => {
    expect(parsePortableRecord(record("/n/novadeck-1.2.0.AppImage", "1.2.0"))).toEqual({
      path: "/n/novadeck-1.2.0.AppImage",
      version: "1.2.0",
    })
    expect(parsePortableRecord(record("/n/a", "1.2.0-early.3"))).toEqual({
      path: "/n/a",
      version: "1.2.0-early.3",
    })
  })

  it("is nothing for anything else", () => {
    for (const text of [
      "",
      "not json",
      "null",
      "[]",
      record("", "1.2.0"),
      record("/n/a", "latest"),
      record("/n/a", "1.2"),
      record("/n/a\nb", "1.2.0"),
      record("/n/" + "a".repeat(1100), "1.2.0"),
      JSON.stringify({ version: "1.2.0" }),
      JSON.stringify({ path: 3, version: "1.2.0" }),
    ])
      expect(parsePortableRecord(text)).toBeUndefined()
  })
})

const recording = (
  text: string | undefined,
  options: { self?: string[]; usable?: string[]; fail?: boolean } = {},
) => {
  const written: string[] = []
  const logged: string[] = []
  const host: RecordHost = {
    read: () => text,
    write: (next) => {
      if (options.fail) throw new Error("EACCES")
      written.push(next)
    },
    isSelf: (path) => options.self?.includes(path) ?? false,
    usable: (path) => options.usable?.includes(path) ?? true,
    log: (message) => void logged.push(message),
  }
  return { host, written, logged }
}
const own = { path: "/n/one.AppImage", version: "1.1.0" }

describe("a portable copy recording itself", () => {
  it("writes its path and version when there is no record or a broken one", () => {
    for (const text of [undefined, "garbage"]) {
      const { host, written } = recording(text)
      recordPortableCopy(host, own)
      expect(written.map((line) => JSON.parse(line))).toEqual([own])
    }
  })

  it("replaces the record of the same or an older version", () => {
    for (const version of ["1.1.0", "1.0.0"]) {
      const { host, written } = recording(record("/n/other", version))
      recordPortableCopy(host, own)
      expect(written).toHaveLength(1)
    }
  })

  it("leaves a record alone that names a newer copy which can still be started", () => {
    const { host, written } = recording(record("/n/two.AppImage", "1.2.0"))
    recordPortableCopy(host, own)
    expect(written).toEqual([])
  })

  it("replaces a newer record whose copy is gone, or that names this very copy", () => {
    const gone = recording(record("/n/two.AppImage", "1.2.0"), { usable: [] })
    recordPortableCopy(gone.host, own)
    expect(gone.written).toHaveLength(1)
    const self = recording(record(own.path, "1.9.0"), { self: [own.path] })
    recordPortableCopy(self.host, own)
    expect(JSON.parse(self.written[0] ?? "")).toEqual(own)
  })

  it("does not rewrite what is already there", () => {
    const same = recording(record(own.path, own.version))
    recordPortableCopy(same.host, own)
    expect(same.written).toEqual([])
  })

  it("logs a record it could not write, and carries on", () => {
    const { host, logged } = recording(undefined, { fail: true })
    expect(() => recordPortableCopy(host, own)).not.toThrow()
    expect(logged).toEqual(["The portable copy was not recorded."])
  })
})

const handing = (
  text: string | undefined,
  overrides: Partial<HandoffCheck> = {},
  options: { started?: boolean } = {},
) => {
  const calls: string[] = []
  const check: HandoffCheck = {
    portable: true,
    version: "1.1.0",
    read: () => text,
    isSelf: () => false,
    usable: () => true,
    log: (message) => void calls.push(`log ${message}`),
    start: async (path) => {
      calls.push(`start ${path}`)
      return options.started ?? true
    },
    alert: async (path) => void calls.push(`alert ${path}`),
    installedVersion: async () => undefined,
    recentHandoff: () => false,
    markHandoff: () => void calls.push("mark"),
    quit: () => void calls.push("quit"),
    ...overrides,
  }
  return { check, calls }
}
const newer = record("/n/two.AppImage", "1.2.0")

describe("a portable copy handing its launch to a newer one", () => {
  it("starts the copy the record names, which ends this launch", async () => {
    const { check, calls } = handing(newer)
    expect(await leaveForNewerPortable(check)).toBe(true)
    expect(calls).toEqual(["mark", "start /n/two.AppImage"])
  })

  it("leaves an installed copy to its own check, and a copy that is not portable alone", async () => {
    const { check, calls } = handing(newer, { portable: false })
    expect(await leaveForNewerPortable(check)).toBe(false)
    expect(calls).toEqual([])
  })

  it("carries on for a missing, broken, same-version or older record", async () => {
    for (const text of [
      undefined,
      "garbage",
      record("/n/two.AppImage", "1.1.0"),
      record("/n/two.AppImage", "1.0.0"),
    ]) {
      const { check, calls } = handing(text)
      expect(await leaveForNewerPortable(check)).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it("carries on when the record names this very copy", async () => {
    const { check, calls } = handing(newer, { isSelf: () => true })
    expect(await leaveForNewerPortable(check)).toBe(false)
    expect(calls).toEqual([])
  })

  it("carries on when the copy is gone or cannot be run, without starting anything", async () => {
    const { check, calls } = handing(newer, { usable: () => false })
    expect(await leaveForNewerPortable(check)).toBe(false)
    expect(calls).toEqual([])
  })

  it("starts the recorded copy when the installed one is older than it, whatever this copy's version", async () => {
    for (const installed of ["1.0.0", "1.1.0", "1.1.5"]) {
      const { check, calls } = handing(newer, { installedVersion: async () => installed })
      expect(await leaveForNewerPortable(check)).toBe(true)
      expect(calls).toEqual(["mark", "start /n/two.AppImage"])
    }
  })

  it("leaves the launch to the installed copy when that is as new as the record or newer", async () => {
    for (const installed of ["1.2.0", "1.3.0"]) {
      const { check, calls } = handing(newer, { installedVersion: async () => installed })
      expect(await leaveForNewerPortable(check)).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it("goes by the record when the installed copies can't be looked at", async () => {
    const { check } = handing(newer, {
      installedVersion: async () => {
        throw new Error("gone")
      },
    })
    expect(await leaveForNewerPortable(check)).toBe(true)
  })

  it("stays when it handed a launch over just now, so two copies never start each other for ever", async () => {
    const { check, calls } = handing(newer, { recentHandoff: () => true })
    expect(await leaveForNewerPortable(check)).toBe(false)
    expect(calls).toEqual(["log Handed over just now; carrying on in this copy."])
  })

  it("tells the person and quits when a copy that has run will not start", async () => {
    const { check, calls } = handing(newer, {}, { started: false })
    expect(await leaveForNewerPortable(check)).toBe(true)
    expect(calls).toEqual(["mark", "start /n/two.AppImage", "alert /n/two.AppImage", "quit"])
  })
})
