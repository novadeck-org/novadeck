import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { novaHome } from "@novadeck/harness-nova/pin"

import type { AgentSetup } from "./agent.js"
import { pi } from "./pi.js"

/**
 * Nova (harnesses/nova.ts), the tour's agent: pi as `pi` is here (its screen,
 * its tools, its transcripts), but the runner downloads it itself (from the e2e cache's copy,
 * nova-cache.ts), nothing is installed from npm and no connection of the person's pi is made. It
 * runs on its own agent folder under the deck's data folder, so the sandbox's `~/.pi/agent` is
 * never read or written, and its model is the tour's, registered by Novadeck's extension from the
 * two variables its launcher gets from the runner (Nova's model service and ticket):
 * `nova/gpt-6-luna`, the footer's `gpt-6-luna` and the thinking level. The tests that use it start
 * it by the tour's command (`novadeck-nova --model nova/gpt-6-luna --thinking medium`) and set the
 * fake model service up first (`fakeNovaService`).
 */
export const nova: AgentSetup = {
  ...pi,
  name: "Nova",
  own: true,
  // Its first screen is pi's: its header (version, key hints, the loaded `[Extensions] novadeck.mjs`),
  // the box between two rules, and under it the working folder and a footer with the context
  // use on the left and, on the right, the model and thinking level: `gpt-6-luna • medium`
  // (run on the fake tour service, pi 1.6.0, 2026-11-25). The banner is `pi`'s with that model.
  banner: /[^\s─][\s\S]*?\n─{8,}[\s\S]*gpt-6-luna/,
  prepare: async (sandbox, _model, installed) => {
    // Its agent folder is the deck's data folder's (`novaHome`), where the runner's shell
    // files and its copy of pi live (the fixture's `data`).
    const folder = novaHome(join(sandbox.root, "data"))
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(
      join(folder, "settings.json"),
      // No changelog banner for the version run.
      JSON.stringify({ lastChangelogVersion: installed.version }),
    )
    return { PI_OFFLINE: "1", PI_TELEMETRY: "0" }
  },
}
