import { describe, expect, it } from "vitest"

import { codex } from "./index.js"

const { kept, resume } = codex.launch

describe("the flags a resumed Codex keeps", () => {
  it("are its approval policy, sandbox, model and effort, in any spelling it reads", () => {
    expect(kept!(["--ask-for-approval", "never", "--sandbox", "danger-full-access"])).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "danger-full-access",
    ])
    expect(kept!(["-a", "on-request", "-s", "read-only", "-m", "gpt-5"])).toEqual([
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5",
    ])
    expect(kept!(["-sread-only", "--model=gpt-5", "-a=never"])).toEqual([
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5",
      "--ask-for-approval",
      "never",
    ])
    expect(kept!(["--dangerously-bypass-approvals-and-sandbox"])).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ])
    expect(kept!(["--full-auto", "--approve-for-me", "--dangerously-bypass-hook-trust"])).toEqual([
      "--full-auto",
      "--approve-for-me",
      "--dangerously-bypass-hook-trust",
    ])
  })

  it("keep the config overrides of those settings and no other", () => {
    expect(
      kept!([
        "-c",
        "model_reasoning_effort=high",
        "--config",
        "approval_policy=never",
        "-c",
        "sandbox_mode=read-only",
        "-c",
        "model=gpt-5",
      ]),
    ).toEqual([
      "-c",
      "model_reasoning_effort=high",
      "-c",
      "approval_policy=never",
      "-c",
      "sandbox_mode=read-only",
      "-c",
      "model=gpt-5",
    ])
    // The shim's title setting, and the person's other overrides, are not its to repeat.
    expect(kept!(["-c", "tui.terminal_title=[x]", "-c", "mcp_servers.x.command=y"])).toEqual([])
    expect(kept!(["-c", "approval_policy=never", "-c", "approval_policy=untrusted"])).toEqual([
      "-c",
      "approval_policy=untrusted",
    ])
  })

  it("leave out a prompt, a positional, the session, its profile and what it doesn't know", () => {
    expect(kept!(["resume", "019f-aaaa", "--sandbox", "read-only"])).toEqual([
      "--sandbox",
      "read-only",
    ])
    expect(kept!(["write a test", "--last"])).toEqual([])
    expect(kept!(["-p", "work", "--search", "--image", "a.png", "b.png"])).toEqual([])
    expect(kept!(["--add-dir", "/x", "-s", "read-only"])).toEqual(["--sandbox", "read-only"])
    expect(kept!(["--no-daemon", "--unknown", "-m", "gpt-5"])).toEqual(["--model", "gpt-5"])
  })

  it("come after the model and effort asked for, which replace the launch's own", () => {
    const launched = kept!([
      "-m",
      "gpt-5",
      "-c",
      "model_reasoning_effort=high",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_mode=read-only",
    ])
    expect(resume!("s-1", {}, launched)).toEqual([
      "codex",
      "resume",
      "--model",
      "gpt-5",
      "-c",
      "model_reasoning_effort=high",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_mode=read-only",
      "s-1",
    ])
    expect(resume!("s-1", { model: "o4", effort: "low" }, launched)).toEqual([
      "codex",
      "resume",
      "--model",
      "o4",
      "-c",
      "model_reasoning_effort=low",
      "--ask-for-approval",
      "never",
      "-c",
      "sandbox_mode=read-only",
      "s-1",
    ])
    expect(resume!("s-1")).toEqual(["codex", "resume", "s-1"])
  })
})
