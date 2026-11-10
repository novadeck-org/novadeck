import { describe, expect, it } from "../test.js"
import { shownCommand } from "./shown-command.js"

describe("a shell's command as listings show it", () => {
  it("is its program and the plain words after it", () => {
    expect(shownCommand(["pnpm", "dev:web"])).toBe("pnpm dev:web")
    expect(shownCommand(["/usr/bin/npm", "run", "test"])).toBe("npm run test")
    expect(shownCommand(["C:\\Program Files\\nodejs\\npm.cmd", "start"])).toBe("npm start")
    expect(shownCommand(["vim"])).toBe("vim")
  })

  it("names a script rather than its interpreter", () => {
    expect(shownCommand(["node", "/usr/lib/node_modules/pnpm/bin/pnpm.cjs", "dev:web"])).toBe(
      "pnpm dev:web",
    )
    expect(shownCommand(["python3", "manage.py", "runserver"])).toBe("manage runserver")
    // An option to the interpreter is no script.
    expect(shownCommand(["node", "--inspect", "server.js"])).toBe("node")
  })

  it("stops before a word that could carry a value, so no secret shows", () => {
    expect(shownCommand(["curl", "-H", "Authorization: Bearer x", "https://api"])).toBe("curl")
    expect(shownCommand(["gh", "auth", "login", "--with-token"])).toBe("gh auth login")
    expect(shownCommand(["tool", "login", "ghp_0123456789abcdefABCDEF"])).toBe("tool login")
    expect(shownCommand(["deploy", "TOKEN=abc"])).toBe("deploy")
    expect(shownCommand(["ssh", "me@host"])).toBe("ssh")
    expect(shownCommand(["cat", "/etc/hosts"])).toBe("cat")
    expect(shownCommand(["make", "a", "b", "c", "d"])).toBe("make a b c")
  })

  it("is nothing where nothing tells", () => {
    expect(shownCommand(null)).toBeNull()
    expect(shownCommand([])).toBeNull()
    expect(shownCommand(["weird name;rm"])).toBeNull()
  })
})
