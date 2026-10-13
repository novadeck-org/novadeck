import { describe, expect, it } from "vitest"

import { createMockTerminal, mockReply } from "./samples"

const shell = createMockTerminal(
  { projectId: "storefront", workspaceSessionId: "initial" },
  7,
  "~/projects/storefront",
)

describe("the demo shell", () => {
  it("answers help with what works and that it is simulated", () => {
    const reply = mockReply("help", shell)

    expect(reply).toContain("Local demo commands")
    expect(reply).toContain("simulated")
  })

  it("answers ls and git status like a shell would", () => {
    expect(mockReply("ls -la", shell)).toContain("package.json")
    expect(mockReply("git status", shell)).toContain("working tree clean")
  })

  it("sends claude and codex to a terminal that runs an agent, without naming one", () => {
    for (const line of ["claude", "codex"]) {
      const reply = mockReply(line, shell)

      expect(reply).toContain("running one")
      expect(reply).not.toContain("Checkout")
    }
  })

  it("matches a program by its own name, not one on the object prototype", () => {
    for (const line of ["__proto__", "constructor", "toString", "hasOwnProperty valueOf"]) {
      const reply = mockReply(line, shell)

      expect(reply).toBeTypeOf("string")
      expect(reply).toContain(`command not found: ${line.split(" ")[0]}`)
    }
  })

  it("answers a shell's everyday commands with a note, not an error", () => {
    for (const line of ["pnpm test", "npm run dev", "node -v", "cat package.json", "exit"]) {
      const reply = mockReply(line, shell)

      expect(reply).toContain("simulated shell")
      expect(reply).not.toContain("command not found")
    }
    expect(mockReply("cd application", shell)).toBe("")
  })

  it("answers an agent's terminal as an agent, whatever program the line starts with", () => {
    const agent = { ...shell, command: "claude", process: "claude" }

    expect(mockReply("git commit the fix", agent)).toContain("mock AI session")
    expect(mockReply("ls the files that changed", agent)).toContain("mock AI session")
    expect(mockReply("pnpm please", agent)).toContain("mock AI session")
  })

  it("does not dead-end on a command it does not know", () => {
    const reply = mockReply("fnord --now", shell)

    expect(reply).toContain("command not found: fnord")
    expect(reply).toContain("simulated shell")
    expect(reply).toContain("help")
  })
})
