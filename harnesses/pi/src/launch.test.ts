import { describe, expect, it } from "vitest"

import { launch, resumedBy } from "./launch.js"

const id = "01a20d40-378d-7794-858b-731ee2ba307c"
const file = `/home/person/.pi/agent/sessions/--home-person-project--/2026-11-24T10-53-31-839Z_${id}.jsonl`

describe("resuming a pi session", () => {
  it("names the session's file, which pi opens in its own folder from any other", () => {
    expect(launch.resume!(id, {}, [], file)).toEqual(["pi", "--session", file])
    expect(resumedBy(id, "C:\\Users\\person\\.pi\\agent\\sessions\\--C--p--\\t_x.jsonl")).toBe(
      "C:\\Users\\person\\.pi\\agent\\sessions\\--C--p--\\t_x.jsonl",
    )
  })

  it("names its id where no file was named, or one no shell would read as one word", () => {
    expect(launch.resume!(id)).toEqual(["pi", "--session", id])
    expect(resumedBy(id, "/home/my person/.pi/agent/sessions/p/t_x.jsonl")).toBe(id)
    expect(resumedBy(id, "/home/person/x.jsonl; rm -rf ~")).toBe(id)
    expect(resumedBy(id, "relative/t_x.jsonl")).toBe(id)
    expect(resumedBy(id, "/home/person/notes.txt")).toBe(id)
  })

  it("keeps the model and effort it is asked for, and the flags pi forgets", () => {
    expect(
      launch.resume!(id, { model: "openai/gpt-6", effort: "high" }, ["--no-mcp"], file),
    ).toEqual([
      "pi",
      "--model",
      "openai/gpt-6",
      "--thinking",
      "high",
      "--no-mcp",
      "--session",
      file,
    ])
  })
})
