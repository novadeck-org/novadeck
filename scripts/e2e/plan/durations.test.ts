import { describe, expect, it } from "../../test"
import { filesIn, jobOf } from "./durations.ts"

describe("an E2E job's recorded times", () => {
  it("reads each suite file's time from its line, in seconds, and none for one skipped whole", () => {
    const log = [
      "2026-11-15T21:40:01.1Z  \u001b[32m✓\u001b[39m src/e2e/chat.e2e.ts \u001b[2m(12 tests | 3 skipped)\u001b[22m\u001b[33m 235493\u001b[2mms\u001b[22m\u001b[39m",
      "2026-11-15T21:40:02.1Z  ✓ src/e2e/team.mixed.e2e.ts (4 tests | 3 skipped) 6ms",
      "2026-11-15T21:40:02.5Z  ↓ src/e2e/windows-quirks.e2e.ts (6 tests | 6 skipped)",
      "2026-11-15T21:40:03.1Z  ❯ src/e2e/inbox.e2e.ts (9 tests | 1 failed) 1m 2s",
      "2026-11-15T21:40:04.1Z      ✓ rings an idle agent 2001ms",
      "2026-11-15T21:40:05.1Z  ✓ src/e2e/probes/startup-screens.e2e.ts (1 test) 9ms",
    ].join("\n")
    expect(Object.fromEntries(filesIn(log))).toEqual({
      "chat.e2e.ts": 235.493,
      "team.mixed.e2e.ts": 0.006,
      "windows-quirks.e2e.ts": 0,
      "inbox.e2e.ts": 62,
    })
  })

  it("knows a harness's jobs by their names, shards and systems, and no other job", () => {
    expect(jobOf("Claude Code (2/3)")).toEqual({ harness: "claude", system: "linux" })
    expect(jobOf("Codex (Windows, 1/2)")).toEqual({ harness: "codex", system: "windows" })
    expect(jobOf("Antigravity (macOS)")).toEqual({ harness: "agy", system: "macos" })
    expect(jobOf("Codex")).toEqual({ harness: "codex", system: "linux" })
    for (const name of [
      "Mixed",
      "Mixed (Windows)",
      "Core scenarios (macOS)",
      "Codex (Windows quirks)",
      "Probes (Codex, 1/5)",
      "Plan",
    ])
      expect(jobOf(name), name).toBeUndefined()
  })
})
