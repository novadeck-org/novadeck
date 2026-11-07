import { describe, expect, it } from "vitest"

import { claude } from "./index.js"

const { kept, resume } = claude.launch

describe("the flags a resumed Claude Code keeps", () => {
  it("are its permission mode, model and effort, as it was launched with them", () => {
    expect(kept!(["--permission-mode", "plan", "--model", "opus", "--effort", "high"])).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--effort",
      "high",
    ])
    expect(kept!(["--permission-mode=acceptEdits", "--model=sonnet"])).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--model",
      "sonnet",
    ])
    expect(kept!(["--dangerously-skip-permissions"])).toEqual(["--dangerously-skip-permissions"])
    expect(kept!(["--allow-dangerously-skip-permissions"])).toEqual([
      "--allow-dangerously-skip-permissions",
    ])
  })

  it("leave out a prompt, a positional, the session, a print run and what it doesn't know", () => {
    expect(kept!(["fix the bug", "--dangerously-skip-permissions"])).toEqual([
      "--dangerously-skip-permissions",
    ])
    expect(kept!(["--resume", "s-1", "--session-id", "s-2", "--name", "x"])).toEqual([])
    expect(kept!(["--settings", "/x/statusline.json", "--mcp-config", "a.json", "b.json"])).toEqual(
      [],
    )
    expect(kept!(["-p", "--permission-mode", "plan", "do it"])).toEqual([])
    expect(kept!(["--print", "--dangerously-skip-permissions"])).toEqual([])
    expect(kept!(["--made-up-flag", "--model", "opus"])).toEqual(["--model", "opus"])
    // Past `--`, the words are the prompt's.
    expect(kept!(["--", "--permission-mode", "plan"])).toEqual([])
  })

  it("don't read the value of another option as a flag, nor a list's words", () => {
    expect(kept!(["--system-prompt", "--model", "--effort", "low"])).toEqual(["--effort", "low"])
    expect(kept!(["--add-dir", "a", "b", "--model", "opus"])).toEqual(["--model", "opus"])
    expect(kept!(["--append-system-prompt=--model", "x"])).toEqual([])
  })

  it("take the last of a flag given twice, and nothing unfit for a shell's command line", () => {
    expect(kept!(["--model", "opus", "--model", "sonnet"])).toEqual(["--model", "sonnet"])
    expect(kept!(["--model", "opus[1m]"])).toEqual([])
    expect(kept!(["--model", "a b"])).toEqual([])
    expect(kept!(["--model", "$(x)"])).toEqual([])
    expect(kept!(["--model"])).toEqual([])
    // As Commander reads it, the next word is the value, option or not: `--effort` is not one.
    expect(kept!(["--model", "--effort", "low"])).toEqual([])
  })

  it("give back only what a resume doesn't bring back, after the model and effort asked for", () => {
    const launched = kept!([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
    ])
    // All are kept with the session; Claude Code brings back the mode and model itself.
    expect(launched).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "opus",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
    ])
    expect(resume!("s-1", {}, launched)).toEqual([
      "claude",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
      "--resume",
      "s-1",
    ])
    expect(resume!("s-1", { effort: "low" }, launched)).toEqual([
      "claude",
      "--effort",
      "low",
      "--dangerously-skip-permissions",
      "--resume",
      "s-1",
    ])
    expect(resume!("s-1", { model: "sonnet" }, launched)).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--dangerously-skip-permissions",
      "--resume",
      "s-1",
    ])
    expect(resume!("s-1")).toEqual(["claude", "--resume", "s-1"])
  })
})
