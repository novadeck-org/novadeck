import { randomBytes } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { redacted } from "./marks.js"
import { maskScreen, redactScreen } from "./screen.js"

// A line in rows of `width` characters.
const chop = (text: string, width: number): string[] =>
  text.match(new RegExp(`.{1,${width}}`, "gu")) ?? []
// Each row of a screen but the last going on in the next.
const continuing = (screen: readonly string[]): boolean[] =>
  screen.map((_row, i) => i < screen.length - 1)
// Rows as a narrow pane draws them: each long line in pieces, all but the last continuing.
const drawn = (lines: string[], width: number) => {
  const screen: string[] = []
  const continues: boolean[] = []
  for (const line of lines) {
    const pieces = chop(line, width)
    pieces.forEach((piece, i) => {
      screen.push(piece)
      continues.push(i + 1 < pieces.length)
    })
  }
  return { screen, continues }
}
// The lines as a narrow pane draws them, redacted.
const redactDrawn = (lines: string[], width: number): string[] => {
  const { screen, continues } = drawn(lines, width)
  return redactScreen(screen, continues)
}
// This thread's own CPU time for `run`, in milliseconds: a loaded machine makes the wall clock
// run on while the test waits for a core, but not this.
const cpuTime = (run: () => unknown): number => {
  const started = process.threadCpuUsage()
  run()
  const { user, system } = process.threadCpuUsage(started)
  return (user + system) / 1000
}

describe("redacting a shell's screen, row by row", () => {
  it.each([
    ["Compiling serde_json", "ghp_A1b2C3d4E5f6G7h8I9j0", "ghp_A1b2"],
    ["LOG_LEVEL=DEBUG_INFO", "TOKEN=hunter2xyz99", "hunter2xyz99"],
    ["[====] 100% 12/12 1s", "sk_live_abcd1234efghijkl", "sk_live_abcd"],
    ["host 14:47 10", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2", "ghp_A1b2"],
    ["Compiling serde_json", "AKIAIOSFODNN7EXAMPLE", "AKIAIOSFOD"],
  ])("finds a secret at the start of the row after %s", (before, row, secret) => {
    const screen = redactScreen(["$ cat out", before, row, "$"], [false, true, false, false])

    expect(screen.join("\n")).not.toContain(secret)
    expect(screen).toHaveLength(4)
    // The row before may go too: a group that redacts differently as one is masked whole.
    expect([before, redacted]).toContain(screen[1])
  })

  it("masks a secret split across a full row on both rows", () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const screen = redactScreen(
      ["$ sha256sum f", hex.slice(0, 40), hex.slice(40), "$"],
      [false, true, false, false],
    )

    expect(screen.join("")).not.toMatch(/9f86d0|15b0f00a/)
    expect(screen).toHaveLength(4)
    expect(screen[1]).toContain(redacted)
    expect(screen[2]).toContain(redacted)
    expect(screen[0]).toBe("$ sha256sum f")
    expect(screen[3]).toBe("$")
  })

  it("masks a token split mid-way", () => {
    const screen = redactScreen(
      ["env | grep STRIPE", "STRIPE_SECRET_KEY=sk_li", "ve_51HxYzAbCdEfGhIjKlMn"],
      [false, true, false],
    )

    expect(screen.join("")).not.toMatch(/sk_li|51HxYz/)
    expect(screen).toHaveLength(3)
  })

  it("does not join rows that don't continue, so a hex run stops at the row", () => {
    const rows = [
      "commit 69231a3e0f1d2c3b4a5968778695a4b3c2d1e0f9",
      "Author: Ada",
      "69231a3e0f1d2c3b",
    ]

    expect(redactScreen(rows, [false, false, false])).toEqual(rows)
  })

  it("keeps boxes and progress bars as they are", () => {
    const rows = [
      "┌────────────────────┐│ build              │",
      "│ [=======>      ] 52% │",
      "└────────────────────┘",
    ]

    expect(redactScreen(rows, [true, true, false])).toEqual(rows)
  })
})

describe("redacting key blocks across a screen's rows", () => {
  const body = [
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    "QyNTUxOQAAACDx4kq9YtmpHq1q2kQZp0bq2M9r9kq8Xq1wQnR3sQe9RgAAAJjZp8Xp2afF",
    "AAAEDu7Wt2Zf3gq1pX8yq9sh",
  ]
  const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", ...body, "-----END OPENSSH PRIVATE KEY-----"]

  it.each([33, 40, 80])("masks every row of a key block in a %s-column pane", (width) => {
    const { screen, continues } = drawn(["$ cat id_ed25519", ...pem, "$"], width)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/b3Blbn|QyNTUx|AAAEDu7|OPENSSH|BEGIN/)
    expect(result).toHaveLength(screen.length)
    expect(result[0]).toBe("$ cat id_ed25519")
    expect(result.at(-1)).toBe("$")
  })

  it("masks to the end of the screen when the END marker is not visible", () => {
    const { screen, continues } = drawn(["$ cat id", pem[0] ?? "", ...body], 80)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/b3Blbn|QyNTUx|AAAEDu7/)
    expect(result[0]).toBe("$ cat id")
  })

  it("masks a service account's private key in a JSON line drawn in pieces", () => {
    const line = `  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\\n-----END PRIVATE KEY-----\\n",`
    const { screen, continues } = drawn(["$ cat sa.json", "{", line, "}"], 80)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toContain("MIIEvQ")
  })

  const key = [
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7aaaa",
    "bbbbQyNTUxOQAAACDx4kq9YtmpHq1q2kQZp0bq2M9r9kq8Xq1wQnR3sQe9Rg",
  ]

  it("masks a key that begins on the row where a certificate ends", () => {
    const screen = redactDrawn(
      [
        "$ cat cert.pem key.pem",
        "-----END CERTIFICATE----------BEGIN PRIVATE KEY-----",
        ...key,
        "-----END PRIVATE KEY-----",
        "$",
      ],
      80,
    )

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$")
  })

  it.each([["-----BEGIN PRIVATE KEY"], ["-----BEGIN RSA PRIVATE KEY--"]])(
    "starts a block at %s, a marker cut short",
    (begin) => {
      const screen = redactDrawn(["$ cat key", begin, ...key], 80)

      expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
      expect(screen[0]).toBe("$ cat key")
    },
  )

  it("masks from the top of the screen to an END whose BEGIN scrolled away", () => {
    const screen = redactDrawn([...key, "-----END PRIVATE KEY-----", "$ ls"], 80)

    expect(screen.join("\n")).not.toMatch(/MIIEvQ|bbbbQy/)
    expect(screen.at(-1)).toBe("$ ls")
  })
})

describe("redacting values across a screen's rows", () => {
  it.each([
    ["{'debug': False, 'smtp_password': 'Zq8rT2mWx9LpKd3VnB7sYcHt5Gf', 'port': 25}"],
    ['{"level":"info","api_secret": "Zq8rT2mWx9LpKd3VnB7sYcHt5Gf'],
    ["      postgresPassword: 'Zq8rT2mWx9LpKd3VnB7sYcHt5Gf'  # prod"],
    ['{"level":"info","api_secret": "Zq8rT2mWx9LpKd3VnB7sYcHt5Gf", "n": 1}'],
  ])("masks a value drawn across rows: %s", (line) => {
    const { screen, continues } = drawn(["$ tail -f app.log", line, "$"], 40)

    const result = redactScreen(screen, continues)

    expect(result.join("\n")).not.toMatch(/Zq8r|T2mW|LpKd|Vn[B7]|Yc?Ht|5Gf/)
    expect(result[0]).toBe("$ tail -f app.log")
    expect(result.at(-1)).toBe("$")
  })

  it("leaves a continued pair alone when nothing crosses its boundary", () => {
    const rows = ["Compiling serde_json", "Compiling tokio v1.4"]

    expect(redactScreen(rows, [true, false])).toEqual(rows)
  })

  it.each([
    "DATABASE_PASSWORD=Zq8rT2mWx9LpKd3VnB7sYcHt5GfAb4Cd6EfGh8Ij",
    "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'",
  ])("masks every row of a secret across three rows or more: %s", (line) => {
    for (const width of [20, 33, 40]) {
      const screen = redactDrawn(["$ run", line, "$"], width)

      expect(screen.join("\n")).not.toMatch(/Zq8r|LpKd|Ij$|dozjg|R8U|eyJhb/m)
      expect(screen[0]).toBe("$ run")
    }
  })

  it("masks only the characters of an integrity hash that fills rows, not the line around it", () => {
    const line =
      "npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. integrity sha512-9xq2Vb8Kc3Lm5Np7Rs1Tv4Wy6Zb0Cd2Ef5Gh8Ij1Kl3Mn6Op9Qr2St5Uv8Wx1Yz4Ab7Cd0Ef3Gh6Ij9Kl2Mn5Op8Qr1St4Uv7Wx0Yz3A=="

    const rows = redactDrawn([line], 40)

    expect(rows.slice(0, 2).join("")).toBe(line.slice(0, 80))
    expect(rows[0]).toBe(line.slice(0, 40))
  })

  it("masks a token that starts a row after a row ending in a word character, and the rest of it", () => {
    const token = "ghp_OHM6rIz5PEGNr6Df0PCSJaqSIz3B0eBMR2mP"
    const rows = redactDrawn([`${"x".repeat(20)}${token}" ok`], 20)

    expect(rows.join("\n")).not.toMatch(/OHM6|0PCS/)
    expect(rows[0]).toBe("x".repeat(20))
  })

  it("masks a nested assignment across continued rows after a long ordinary value", () => {
    const result = redactDrawn([`outer=${"a=b".repeat(800)}=PASSWORD=Hunter2xyz!`], 40).join("")
    expect(result).not.toMatch(/Hunter|2xyz/)
    expect(result).toContain(redacted)
  })
})

describe("a token after a row that ended in a word character", () => {
  it("is masked to its end, however long", () => {
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ".repeat(3)}.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV`
    const lines = [`${"x".repeat(20)}`, ...jwt.match(/.{1,20}/g)!, "$"]
    const continues = lines.map((_row, i) => i < lines.length - 1 && lines[i]!.length === 20)

    const result = redactScreen(lines, continues).join("\n")

    expect(result).not.toMatch(/eyJh|SflKx|eyJzd|IkpvaG4/)
  })
})

describe("a secret behind a label that ends a row", () => {
  it.each([
    ["password: ", "token: B4aTpQ9xK2mWz7LvN3sYcH5g"],
    ["Secret Access Key: ", "token: B4aTpQ9xK2mWz7LvN3sYcH5g"],
    ["API_KEY= ", "ghp_B4aTpQ9xK2mWz7LvN3sYcH5gAbCd"],
  ])("masks the secret on the next row after %s", (label, secret) => {
    const width = 24
    const lines = [label.padStart(width, "x").slice(-width), ...(secret.match(/.{1,24}/g) ?? [])]
    const continues = lines.map((row, i) => i < lines.length - 1 && row.length === width)

    const result = redactScreen(lines, continues).join("\n")

    expect(result).not.toMatch(/B4aTp|Q9xK|WzLv|7LvN|sYcH/)
  })
})

describe("redacting a screen with characters outside the basic plane", () => {
  it("redacts each row without hanging", { timeout: 5000 }, () => {
    const rows = ["julia> 𝐱 = rand(3)", "𠀀: password: 𠀀𠀀", "😀😀😀😀=😀😀😀😀"]
    const screen = redactScreen(rows, [true, true, false])

    expect(screen[0]).toBe(rows[0])
    expect(screen[1]).toBe("𠀀: password: [redacted]")
  })
})

describe("the sentinel character in a screen", () => {
  it("becomes a question mark, in a row and in a group", () => {
    const one = redactScreen([" ~/proj main", "$ ls"], [])
    const group = redactScreen(["TOKEN=abcdefgh", "ij ok"], [true, false])

    expect(one).toEqual(["? ~/proj main", "$ ls"])
    expect(group).toEqual(["TOKEN=[redacted]", "[redacted] ok"])
  })
})

describe("which units of a screen are masked", () => {
  const flagged = (row: string, flags: readonly boolean[] | undefined): string =>
    [...row].map((_unit, i) => (flags?.[i] ? "^" : " ")).join("")

  it("flags the units of a secret and no others, as long as each row", () => {
    const shown = ["$ echo API_KEY=hunter2abc ok", "plain"]

    const masks = maskScreen(shown, [false, false])

    expect(masks.map((flags) => flags.length)).toEqual(shown.map((row) => row.length))
    expect(flagged(shown[0] ?? "", masks[0])).toBe("               ^^^^^^^^^^   ")
    expect(masks[1]?.some(Boolean)).toBe(false)
  })

  it("counts the units of a character that takes two, so a surrogate pair is flagged whole", () => {
    const row = "token=\u{1F600}\u{1F600}abc1 end"

    const [flags] = maskScreen([row], [false])

    expect(flags?.slice(6, 6 + "\u{1F600}\u{1F600}abc1".length).every(Boolean)).toBe(true)
    expect(flags?.length).toBe(row.length)
  })

  it("flags a secret split across a full row on both shown", () => {
    const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a09"
    const shown = ["$ sha256sum f", hex.slice(0, 40), hex.slice(40), "$"]

    const masks = maskScreen(shown, [false, true, false, false])

    expect(masks[1]?.every(Boolean)).toBe(true)
    expect(masks[2]?.every(Boolean)).toBe(true)
    expect(masks[0]?.some(Boolean)).toBe(false)
    expect(masks[3]?.some(Boolean)).toBe(false)
  })

  it("flags every unit of every row a key block covers", () => {
    const shown = ["$ cat key", "-----BEGIN PRIVATE KEY-----", "MIIEvQIBADANBg", "", "$ next"]

    const masks = maskScreen(shown, [false, false, false, false, false])

    expect(masks.map((flags) => flags.every(Boolean))).toEqual([false, true, true, true, true])
    expect(masks.map((flags) => flags.length)).toEqual(shown.map((row) => row.length))
  })

  it("reads a sentinel character in a row as the text it is, not as a mask", () => {
    const [flags] = maskScreen(["a\uE000b"], [false])

    expect(flags).toEqual([false, false, false])
  })

  it("masks exactly what redactScreen writes as a mask", () => {
    const shown = [
      "env | grep STRIPE",
      "STRIPE_SECRET_KEY=sk_li",
      "ve_51HxYzAbCdEfGhIjKlMn",
      "done",
    ]
    const continues = [false, true, false, false]

    const masks = maskScreen(shown, continues)
    const hidden = shown.map((row, i) =>
      [...row].map((unit, at) => (masks[i]?.[at] ? "\uE000" : unit)).join(""),
    )

    expect(hidden.map((row) => row.replaceAll(/\uE000+/g, redacted))).toEqual(
      redactScreen(shown, continues),
    )
  })
})

const rows = (row: string): string[] => Array.from({ length: 60 }, () => row)
const random = (): string =>
  Array.from(
    { length: 400 },
    () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[
        Math.floor(Math.random() * 64)
      ],
  ).join("")

describe("the time redaction takes", () => {
  // Counting every match through a spy is slow on a loaded runner; the count is what is checked.
  it(
    "does not repeatedly parse ordinary assignment values in a continued screen",
    { timeout: 30_000 },
    () => {
      const screen = rows(`${"a=b".repeat(133)}a`)
      const exec = RegExp.prototype.exec
      let characters = 0
      const scanned = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
        this: RegExp,
        text,
      ) {
        const found = exec.call(this, text)
        characters += found?.[0].length ?? 0
        return found
      })
      let result: string[]
      try {
        result = redactScreen(screen, continuing(screen))
      } finally {
        scanned.mockRestore()
      }
      expect(result).toEqual(screen)
      // The overlapping row contexts are intentional. Re-reading 1024-character values
      // at every '=' used to match over 240 million characters in this 24,000-char screen.
      expect(characters).toBeLessThan(screen.join("").length * 80)
    },
  )

  it.each([
    ["Ab1+ repeated", () => rows("Ab1+".repeat(100))],
    ["a=b repeated", () => rows("a=b ".repeat(100).trimEnd().slice(0, 400))],
    ["a=b without spaces", () => rows(`${"a=b".repeat(133)}a`)],
    ["quotes", () => rows('"a: '.repeat(100))],
    ["random base64", () => Array.from({ length: 60 }, random)],
  ])("is quick for a 60 by 400 continued screen of %s", { timeout: 30_000 }, (_name, screen) => {
    const shown = screen()
    // A budget to catch a blow-up (it was 13 s once), not to benchmark: about 150 ms of CPU here.
    // The timeout only bounds a hang, as a loaded runner's wall clock runs far past the CPU's.
    expect(cpuTime(() => redactScreen(shown, continuing(shown)))).toBeLessThan(2000)
  })
})

describe("secrets longer than the window rows are read in", () => {
  const b64 = (length: number): string => {
    let out = ""
    for (let i = 0; out.length < length; i += 1)
      out += Buffer.from(`${i * 7919} Zq8rT2mWx9LpKd3VnB7sYcHt5Gf ${i}`).toString("base64")
    return out.slice(0, length).replaceAll("=", "A")
  }

  it("masks a 6 KB base64 run wrapped across many rows after a word character, end to end", () => {
    const run = b64(6000)
    const screen = chop(`prefix${run} done`, 80)

    const result = redactScreen(screen, continuing(screen))

    expect(result.join("")).not.toContain(run.slice(100, 140))
    expect(result.join("")).not.toContain(run.slice(3000, 3040))
    expect(result.join("")).not.toContain(run.slice(5900, 5940))
  })

  it("masks a 3 KB JWT wrapped across rows", () => {
    const part = b64(1000).replaceAll("+", "-").replaceAll("/", "_")
    const jwt = `eyJ${part}.${part}.${part}`
    const screen = chop(`word ${jwt} end`, 60)

    const result = redactScreen(screen, continuing(screen))

    expect(result.join("")).not.toContain(part.slice(200, 240))
    expect(result.join("")).not.toContain(part.slice(900, 940))
  })

  it.each([
    ["hex", () => "9f86d081884c7d65".repeat(10_000)],
    ["base64", () => b64(160_000)],
    ["a=b", () => "a=b".repeat(53_000)],
    ["quotes", () => '"a: '.repeat(40_000)],
    ["Ab1+", () => "Ab1+".repeat(40_000)],
  ])(
    "is quick for a 2,000-row group of one wrapped line of %s",
    { timeout: 60_000 },
    (_name, line) => {
      const screen = chop(line(), 80)
      // A budget to catch the cost growing with the square of the rows (it was 12 to 45 s; about 1 s now).
      expect(cpuTime(() => redactScreen(screen, continuing(screen)))).toBeLessThan(15_000)
    },
  )
})

describe("tokens longer than the window", () => {
  const visible = (screen: string[], secret: string): number => {
    const text = screen.join("")
    let found = 0
    for (let i = 0; i + 20 <= secret.length; i += 20)
      if (text.includes(secret.slice(i, i + 20))) found += 1
    return found
  }

  it.each([5000, 6300])(
    "masks a %i character JWT glued to a full row that ends in a word character, whole",
    (length) => {
      const part = randomBytes(Math.ceil((length * 3) / 4))
        .toString("base64url")
        .slice(0, length)
      const jwt = `eyJhbGciOiJSUzI1NiJ9.${part}.${part.slice(0, 200)}`
      const screen = chop(`${"=".repeat(119)}x${jwt}`, 120)

      const result = redactScreen(screen, continuing(screen))

      expect(visible(result, jwt.slice(21))).toBe(0)
    },
  )

  it("masks a long token with a prefix whole, wherever it starts in the group", () => {
    const token = `ghp_${randomBytes(4000).toString("base64url").replaceAll(/[-_]/g, "A")}`
    const screen = chop(`${"abcdefg=".repeat(30)}${token}`, 100)

    const result = redactScreen(screen, continuing(screen))

    expect(visible(result, token.slice(4))).toBe(0)
  })
})

describe("what a mask is carried on through", () => {
  it("does not mask the words after a hash that ends where a window does", () => {
    // Rows of 80 columns; the hash ends the row at which a window (4096 characters) ends.
    const filler = "abcdefg hijklmn ".repeat(5)
    const hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    const screen = Array.from({ length: 70 }, (_, i) =>
      i === 52
        ? `${"abcdefg hijklmn "}${hash}`
        : i === 53
          ? ".tar.gz/and/some/plain/words/here"
          : filler,
    )

    const result = redactScreen(screen, continuing(screen))

    expect(result[52]).toContain(redacted)
    expect(result[53]).toBe(".tar.gz/and/some/plain/words/here")
  })
})

describe("the time prefixed tokens take", () => {
  it.each(["sk-", "-hf_", "eyJ"])(
    "grows with the rows, not their square, for one wrapped line of %s repeated",
    { timeout: 60_000 },
    (unit) => {
      const time = (size: number): number => {
        const screen = chop(unit.repeat(Math.floor(size / unit.length)), 120)
        return cpuTime(() => maskScreen(screen, continuing(screen)))
      }
      const small = time(62_500)
      const large = time(250_000)

      // Four times the text takes about four times as long: it took sixteen when each row went
      // over the same run again.
      expect(large).toBeLessThan(8 * small + 300)
    },
  )
})
