import { describe, expect, it } from "../test.js"
import { shownCommand } from "./shown-command.js"

describe("a shell's command as listings show it", () => {
  it("is a known tool and its subcommand, or the script its runner runs", () => {
    expect(shownCommand(["pnpm", "dev:web"])).toBe("pnpm dev:web")
    expect(shownCommand(["/usr/bin/npm", "run", "test"])).toBe("npm run test")
    expect(shownCommand(["C:\\Program Files\\nodejs\\npm.cmd", "start"])).toBe("npm start")
    expect(shownCommand(["cargo", "test", "--workspace"])).toBe("cargo test")
    expect(shownCommand(["docker", "compose", "up"])).toBe("docker compose up")
    expect(shownCommand(["make", "a", "b", "c"])).toBe("make a")
  })

  it("is only the program for any other, whatever follows", () => {
    expect(shownCommand(["vim"])).toBe("vim")
    expect(shownCommand(["htop", "-d", "10"])).toBe("htop")
    // A password as a plain word, which nothing could tell from a subcommand.
    expect(shownCommand(["openssl", "passwd", "hunter2"])).toBe("openssl")
    expect(shownCommand(["mysqladmin", "password", "Secret12"])).toBe("mysqladmin")
    expect(shownCommand(["mytool", "login", "admin", "Tr0ub4dor"])).toBe("mytool")
    expect(shownCommand(["aws", "configure", "set", "AKIAIOSFODNN7EXAMPLE"])).toBe("aws")
  })

  it("names a script rather than its interpreter, without its arguments", () => {
    expect(shownCommand(["node", "/usr/lib/node_modules/pnpm/bin/pnpm.cjs", "dev:web"])).toBe(
      "pnpm dev:web",
    )
    expect(shownCommand(["python3", "manage.py", "runserver"])).toBe("manage")
    expect(shownCommand(["python3", "deploy.py", "Passw0rd"])).toBe("deploy")
    // An option to the interpreter is no script.
    expect(shownCommand(["node", "--inspect", "server.js"])).toBe("node")
  })

  it("stops a known tool's words before one that could carry a value", () => {
    expect(shownCommand(["gh", "auth", "login", "--with-token"])).toBe("gh auth")
    expect(shownCommand(["npm", "run", "ghp_0123456789abcdefABCDEF"])).toBe("npm run")
    expect(shownCommand(["git", "TOKEN=abc"])).toBe("git")
    expect(shownCommand(["pnpm", "Hunter2x"])).toBe("pnpm")
    expect(shownCommand(["git", "push", "https://me:token@host/repo"])).toBe("git push")
  })

  it("is nothing where nothing tells", () => {
    expect(shownCommand(null)).toBeNull()
    expect(shownCommand([])).toBeNull()
    expect(shownCommand(["weird name;rm"])).toBeNull()
  })
})
