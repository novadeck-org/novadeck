// Diagnostic for #722, to come out once CI has shown it: on a quiet runner, whether answering
// the console host's request changes how input reaches a child, and whether an answer later
// than the host's 3 s reaches the child as input. It reports times.
import { fileURLToPath } from "node:url"

import { spawn } from "node-pty"

const child = fileURLToPath(new URL("./child.mjs", import.meta.url))
const line = (command) => `${Buffer.from(JSON.stringify(command)).toString("base64")}\n`

const session = (label, answerAfterMs) =>
  new Promise((resolve) => {
    const began = performance.now()
    const at = () => Math.round(performance.now() - began)
    const terminal = spawn(process.execPath, [child], {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      useConptyDll: true,
    })
    const marks = []
    let output = ""
    let write = 0
    let ready = false
    let finished = false
    let sentAt = 0
    let exited = false
    const finish = (why) => {
      if (finished) return
      finished = true
      clearTimeout(limit)
      resolve(`${label}: ${why}; ${marks.join(", ")}; last ${JSON.stringify(output.slice(-120))}`)
      if (!exited) terminal.kill()
    }
    const limit = setTimeout(() => finish("gave up after 20 s"), 20_000)
    const next = () => {
      sentAt = at()
      if (write === 3) return terminal.write(line({ type: "exit", code: 7, data: "FINAL" }))
      terminal.write(line({ type: "write", data: `MARK_${write}` }))
    }
    terminal.onExit(({ exitCode }) => {
      exited = true
      marks.push(`exit ${exitCode} after ${at() - sentAt} ms`)
      finish(output.includes("FINAL") ? "finished" : "ended early")
    })
    terminal.onData((chunk) => {
      output += chunk
      if (chunk.includes("\u001b[c") && answerAfterMs !== undefined)
        setTimeout(() => {
          marks.push(`answered at ${at()}`)
          terminal.write("\u001b[?1;2c")
          // The late case: its first command right behind the answer.
          if (ready && write === 0 && sentAt === 0) next()
        }, answerAfterMs)
      if (!ready && output.includes("PTY_READY")) {
        ready = true
        marks.push(`ready ${at()}`)
        if (answerAfterMs === undefined || answerAfterMs < 3_000) next()
      }
      if (ready && write < 3 && output.includes(`MARK_${write}`)) {
        marks.push(`write ${write} ${at() - sentAt} ms`)
        write += 1
        next()
      }
    })
  })

const modes = [
  ["unanswered", undefined],
  ["answered at once", 0],
  ["answered after 3.5 s", 3_500],
]
for (const [label, after] of modes)
  for (let run = 1; run <= 6; run++)
    // eslint-disable-next-line no-await-in-loop -- One session at a time, as the test runs them.
    process.stdout.write(`Late answer: ${await session(`${label} #${run}`, after)}\n`)
process.exit(0)
