import { describe, expect, it } from "../test.js"
import { osc7Directory, osc9Directory } from "./osc.js"

const posix = process.platform !== "win32"

describe.skipIf(!posix)("OSC 7 directory reports", () => {
  it("decodes a percent-encoded path on this machine", () => {
    expect(osc7Directory("file://box/home/ada/My%20Dir/%C5%BC", "box")).toBe("/home/ada/My Dir/ż")
  })

  it("accepts no host, localhost, and the short or full name of this machine", () => {
    expect(osc7Directory("file:///tmp", "box")).toBe("/tmp")
    expect(osc7Directory("file://localhost/tmp", "box")).toBe("/tmp")
    expect(osc7Directory("file://box.lan/tmp", "box")).toBe("/tmp")
    expect(osc7Directory("file://BOX/tmp", "box.example.com")).toBe("/tmp")
  })

  it("ignores another machine, other schemes, and malformed reports", () => {
    expect(osc7Directory("file://server/srv", "box")).toBeUndefined()
    expect(osc7Directory("http://box/tmp", "box")).toBeUndefined()
    expect(osc7Directory("not a url", "box")).toBeUndefined()
    expect(osc7Directory("file://box/bad%E0%A4%A", "box")).toBeUndefined()
  })
})

describe("OSC 9;9 directory reports", () => {
  const path = posix ? "/home/ada/My Dir" : "C:\\Users\\Ada\\My Dir"

  it("reads the path as sent, with or without quotes", () => {
    expect(osc9Directory(`9;${path}`)).toBe(path)
    expect(osc9Directory(`9;"${path}"`)).toBe(path)
  })

  it("leaves other OSC 9 messages, and relative paths, alone", () => {
    expect(osc9Directory("Build finished")).toBeUndefined()
    expect(osc9Directory("4;1;50")).toBeUndefined()
    expect(osc9Directory("9;relative\\path")).toBeUndefined()
  })
})
