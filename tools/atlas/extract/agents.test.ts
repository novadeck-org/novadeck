import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, test } from "vitest"

import { hookEvents, readLimits } from "./agents.ts"
import { createAnchors } from "./anchors.ts"

const repo = mkdtempSync(join(tmpdir(), "atlas-limits-"))
afterAll(() => rmSync(repo, { recursive: true, force: true }))

// A limit that is no plain literal reports a broken anchor, where it used to throw out of
// the whole extractor and take every brief and `check` with it.
test("reads the protocol's limits, and reports one it cannot evaluate", () => {
  writeFileSync(
    join(repo, "limits.ts"),
    [
      "export const maxAskOptions = 3 as const",
      "export const inboxTextLimits = {\n  subject: 256,\n} as const",
      "export const maxCommandLines = maxLines",
    ].join("\n"),
  )
  const anchors = createAnchors(repo)
  const limits = readLimits(anchors, {
    maxAskOptions: "limits.ts",
    inboxTextLimits: "limits.ts",
    maxCommandLines: "limits.ts",
  })
  expect(limits).toEqual([
    ["maxAskOptions", 3],
    ["inboxTextLimits", { subject: 256 }],
    ["maxCommandLines", undefined],
  ])
  expect(anchors.broken()).toEqual([
    expect.objectContaining({
      where: "mcp tools",
      file: "limits.ts",
      reason: "could not evaluate maxCommandLines: maxLines is not defined",
    }),
  ])
})

test("marks a hook registered only on some machines as conditional", () => {
  const plugin = [
    "  {",
    '    path: "hooks.json",',
    "    content: json({",
    "      novadeck: {",
    '        Stop: [handler(platform, "Stop")],',
    '        ...(!(platform === "win32" && machine.cmdPrints) && {',
    '          PreToolUse: [{ matcher: "*", hooks: [handler(platform, "PreToolUse")] }],',
    "        }),",
    '        PostToolUse: [handler(platform, "PostToolUse")],',
    "      },",
    "    }),",
    "  },",
    "  settings: {}",
  ].join("\n")
  expect(hookEvents(plugin).events).toEqual([
    { event: "Stop", conditional: false },
    { event: "PreToolUse", conditional: true },
    { event: "PostToolUse", conditional: false },
  ])
  expect(hookEvents('const events = [\n  "SessionStart",\n  "Stop",\n]').events).toEqual([
    { event: "SessionStart", conditional: false },
    { event: "Stop", conditional: false },
  ])
})
