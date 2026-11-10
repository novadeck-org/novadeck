import { box as agyBox, slice as agySlice } from "@novadeck/harness-agy/box"
import { box as claudeBox, slice as claudeSlice } from "@novadeck/harness-claude/box"
import { box as codexBox, slice as codexSlice } from "@novadeck/harness-codex/box"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { replaySlices, type SliceFixture } from "@novadeck/harness-core/testing/slices"
import { agentNames, type AgentName } from "@novadeck/protocol/harnesses"

import { harnessSources } from "./harnesses.test-support"
import { describe, expect, it } from "./test"

// What of each recorded screen the chat's live slice takes, replayed state by state as the
// runner reads them, the screen at rest kept: which rows, why, and whether they are a secret
// prompt. A harness that moves what it draws changes the rows here. The fixtures are the
// probe's (`backend/runner/src/e2e/probes/live-slice.e2e.ts`).

const profiles = {
  claude: { box: claudeBox, slice: claudeSlice, folder: "claude" },
  codex: { box: codexBox, slice: codexSlice, folder: "codex" },
  agy: { box: agyBox, slice: agySlice, folder: "agy" },
} as const satisfies Record<AgentName, unknown>

const golden = (agent: AgentName): string => {
  const { box, slice, folder } = profiles[agent]
  const { runs } = loadProbe<SliceFixture>(harnessSources(folder), "live-slice.probe.json")
  const lines = Object.entries(runs).flatMap(([run, steps]) => [
    `# ${run}`,
    ...replaySlices(steps, box, slice).flatMap(({ label, bounds, rows, secret }) => [
      bounds
        ? `${label}: ${bounds.reason} ${bounds.first}-${bounds.last}${secret ? " secret" : ""}`
        : `${label}: none`,
      ...rows.map((row) => `  | ${row}`),
    ]),
    "",
  ])
  return `${lines.join("\n")}\n`
}

describe("the live slice", () => {
  for (const agent of agentNames)
    it(`takes the rows it did of ${agent}'s recorded screens`, async () => {
      await expect(golden(agent)).toMatchFileSnapshot(`./slices/${agent}.txt`)
    })
})
