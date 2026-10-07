import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import { answers, result, own, start } from "../scenarios.js"
import { capture, install, sleep, snap } from "./claude-support.js"

describe.skipIf(!supported)("claude ask probe: Bash permission", () => {
  const it = e2e(claude)
  it("bash dialog, sizes, answer by digit 1", async ({ e2e: run }) => {
    const probe = install(run)
    run.model.use(
      answers("Make the file", () => ({
        calls: [
          {
            name: "Bash",
            input: {
              command: "touch approved.txt",
              description: "Make a file",
            },
          },
        ],
      })),
      own((call) => (result(call) !== undefined ? { text: "Made it." } : undefined)),
    )
    const t = await start(run, claude)
    await t.submit("Make the file")
    await t.until(/❯ 1\. Yes/)
    await sleep(500)
    const big = await snap(t)
    t.resize(60, 20)
    await sleep(800)
    const small = await snap(t)
    t.resize(120, 40)
    await sleep(800)
    await t.until(/❯ 1\. Yes/)
    // answer 1 by digit (no Enter)
    t.press("1")
    await t.until("Made it.")
    await sleep(500)
    const done = await snap(t)
    capture("bash", { big, small, done, log: probe.log() })
    console.log(big.join("\n"), "\n=====\n", small.join("\n"))
    console.log(
      probe
        .log()
        .map((l) => `${l.event}:${l.phase}`)
        .join(" "),
    )
  })
})
