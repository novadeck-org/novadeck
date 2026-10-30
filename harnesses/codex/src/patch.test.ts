import { describe, expect, it } from "vitest"

import { patched } from "./patch.js"
import { hook } from "./report.test-support.js"

const patch = (...files: string[]) =>
  `*** Begin Patch\n${files.map((file) => `*** Add File: ${file}\n+x`).join("\n")}\n*** End Patch`

describe("a patch's files", () => {
  it("are from the session's directory, an absolute one as it is", () => {
    expect(patched({ command: patch("a.ts", "/abs/b.ts", "..foo/c.ts") }, "/w")).toEqual([
      "/w/a.ts",
      "/abs/b.ts",
      "/w/..foo/c.ts",
    ])
  })

  it("are Windows paths from a Windows directory, on any host", () => {
    expect(patched({ command: patch("src\\b.ts", "C:\\Work\\a.ts") }, "C:\\Work")).toEqual([
      "C:\\Work\\src\\b.ts",
      "C:\\Work\\a.ts",
    ])
    expect(patched({ command: patch("\\\\host\\share\\a.ts") }, undefined)).toEqual([
      "\\\\host\\share\\a.ts",
    ])
  })

  it("leave out a relative one where no directory is known, and any call with no patch", () => {
    expect(patched({ command: patch("a.ts", "/abs/b.ts") }, undefined)).toEqual(["/abs/b.ts"])
    expect(patched({ command: "cat /w/a.ts" }, "/w")).toEqual([])
    expect(patched("not an object", "/w")).toEqual([])
  })
})

describe("Codex's permission request", () => {
  const asked = (tool: string, input: unknown) =>
    hook("PermissionRequest", { cwd: "/w", tool_name: tool, tool_input: input })

  it("names the files a patch writes, from the directory it asked in", () => {
    expect(asked("apply_patch", { command: patch("a.ts", "/abs/b.ts") })).toMatchObject([
      { type: "attention-requested", kind: "permission", writes: ["/w/a.ts", "/abs/b.ts"] },
    ])
  })

  it("names none for any other call, whatever its input holds", () => {
    const [request] = asked("exec_command", { command: patch("a.ts") })
    expect(request).toMatchObject({ type: "attention-requested", kind: "permission" })
    expect(request).not.toHaveProperty("writes")
    expect(asked("apply_patch", { command: "nothing" })[0]).not.toHaveProperty("writes")
  })
})
