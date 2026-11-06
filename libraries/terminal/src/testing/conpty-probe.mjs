// Diagnostic for #722, to come out once CI has shown it: where a child's first ~3 s on the
// bundled ConPTY go. It reports times and asserts nothing. The bundled OpenConsole.exe writes
// `ESC [ c` (a request for the terminal's device attributes) and then calls
// WaitOnAddress(..., 3000), so a host that never answers may be what waits.
import { fileURLToPath } from "node:url"

import { spawn } from "node-pty"

const query = "\u001b[c"
// What xterm's emulation, the host's screen, answers a primary device attributes request with.
const answer = "\u001b[?1;2c"
const ready = "PTY_READY"
const giveUpMs = 8_000
const exitMs = 5_000

/**
 * Times one start. `start` gives `{ terminal, native }`: what to read and write, and node-pty's
 * own object, for the private agent. `answerAfterMs` answers the query that long after it came.
 */
export const timeStart = (label, start, { answerAfterMs } = {}) =>
  new Promise((resolve) => {
    const began = performance.now()
    const at = () => Math.round(performance.now() - began)
    const { terminal, native } = start()
    const returned = at()
    const chunks = []
    let output = ""
    let asked
    let answered
    let created
    let last = performance.now()
    let gap = 0
    let finished = false
    const poll = setInterval(() => {
      gap = Math.max(gap, performance.now() - last)
      last = performance.now()
      // eslint-disable-next-line no-underscore-dangle -- The child's id is private to node-pty.
      if (created === undefined && native._agent?._innerPid > 0) created = at()
    }, 5)
    const finish = (first) => {
      if (finished) return
      finished = true
      clearInterval(poll)
      clearTimeout(limit)
      data.dispose?.()
      const shown = chunks.slice(0, 6).join(" ")
      const report =
        `${label}: spawn returned ${returned} ms, child created ${created ?? "?"} ms, ` +
        `query seen ${asked ?? "never"}, answered ${answered ?? "never"}, ` +
        `first output ${first ?? `none in ${giveUpMs}`} ms, longest event-loop gap ` +
        `${Math.round(gap)} ms; chunks: ${shown}`
      // Each start ends before the next, so none waits behind a console left running.
      const done = setTimeout(() => resolve(`${report}; no exit in ${exitMs} ms`), exitMs)
      native.onExit(() => {
        clearTimeout(done)
        resolve(report)
      })
      native.kill()
    }
    const limit = setTimeout(() => finish(), giveUpMs)
    const data = terminal.onData((chunk) => {
      chunks.push(`+${at()}=${JSON.stringify(chunk.slice(0, 120))}`)
      output += chunk
      if (asked === undefined && output.includes(query)) {
        asked = at()
        if (answerAfterMs !== undefined)
          setTimeout(() => {
            if (finished) return
            answered = at()
            terminal.write(answer)
          }, answerAfterMs)
      }
      if (output.includes(ready)) finish(at())
    })
  })

const raw = (args, options) => () => {
  const child = spawn(process.execPath, args, { cols: 80, rows: 24, ...options })
  return { terminal: child, native: child }
}

// Outside Vitest, with nothing else running: raw starts on each ConPTY.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = fileURLToPath(new URL("./child.mjs", import.meta.url))
  const bundled = { cwd: process.cwd(), env: process.env, useConptyDll: true }
  const system = { cwd: process.cwd(), env: process.env, useConptyDll: false }
  const runs = [
    ["plain node, bundled, no answer", bundled, {}],
    ["plain node, bundled, answered", bundled, { answerAfterMs: 0 }],
    ["plain node, bundled, answered after 1 s", bundled, { answerAfterMs: 1_000 }],
    ["plain node, system, no answer", system, {}],
  ]
  for (const [label, options, how] of runs)
    for (let run = 1; run <= 3; run++)
      // eslint-disable-next-line no-await-in-loop -- One start at a time, for clean times.
      process.stdout.write(`${await timeStart(`${label} #${run}`, raw([child], options), how)}\n`)
  // node-pty leaves a conout worker running after an exit.
  process.exit(0)
}
