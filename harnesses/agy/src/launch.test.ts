import { describe, expect, it } from "vitest"

import { agy } from "./index.js"

const { kept, resume } = agy.launch

describe("the flags a resumed Antigravity keeps", () => {
  it("are its mode, permission bypass, sandbox, model and effort", () => {
    expect(
      kept!(["--mode", "plan", "--model", "gemini-3-pro", "--effort", "high", "--sandbox"]),
    ).toEqual(["--mode", "plan", "--model", "gemini-3-pro", "--effort", "high", "--sandbox"])
    expect(kept!(["--dangerously-skip-permissions"])).toEqual(["--dangerously-skip-permissions"])
    expect(kept!(["--mode=accept-edits"])).toEqual(["--mode", "accept-edits"])
  })

  it("read a flag written with one dash, as Go does, and a boolean set false", () => {
    expect(kept!(["-mode", "auto", "-model=m", "-dangerously-skip-permissions"])).toEqual([
      "--mode",
      "auto",
      "--model",
      "m",
      "--dangerously-skip-permissions",
    ])
    expect(kept!(["--sandbox=true"])).toEqual(["--sandbox"])
    expect(kept!(["--sandbox", "--sandbox=false"])).toEqual([])
  })

  it("leave out a prompt, the conversation, a print run and what it doesn't know", () => {
    expect(kept!(["--conversation", "c-1", "-i", "do it", "--mode", "plan"])).toEqual([
      "--mode",
      "plan",
    ])
    expect(kept!(["-p", "--mode", "plan", "do it"])).toEqual([])
    expect(kept!(["--print", "--dangerously-skip-permissions"])).toEqual([])
    expect(kept!(["--prompt", "x", "--mode", "plan"])).toEqual([])
    expect(kept!(["-c", "--settings", "{}", "--project", "p", "--add-dir", "/x"])).toEqual([])
    expect(kept!(["--made-up", "--model", "m"])).toEqual(["--model", "m"])
  })

  it("come after the model and effort asked for, which replace the launch's own", () => {
    const launched = kept!(["--mode", "plan", "--model", "m1", "--effort", "high"])
    expect(resume!("c-1", {}, launched)).toEqual([
      "agy",
      "--mode",
      "plan",
      "--model",
      "m1",
      "--effort",
      "high",
      "--conversation",
      "c-1",
    ])
    expect(resume!("c-1", { model: "m2" }, launched)).toEqual([
      "agy",
      "--model",
      "m2",
      "--mode",
      "plan",
      "--effort",
      "high",
      "--conversation",
      "c-1",
    ])
    expect(resume!("c-1")).toEqual(["agy", "--conversation", "c-1"])
  })

  it("don't give back the permission bypass it remembers", () => {
    const launched = kept!(["--dangerously-skip-permissions", "--sandbox", "--mode", "auto"])
    expect(resume!("c-1", {}, launched)).toEqual([
      "agy",
      "--sandbox",
      "--mode",
      "auto",
      "--conversation",
      "c-1",
    ])
  })
})
