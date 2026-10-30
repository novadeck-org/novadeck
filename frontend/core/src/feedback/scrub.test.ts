import { context, describe, expect, it } from "../test"
import { scrub, strikeSummary, textToSend } from "./scrub"

const struck = (text: string): string[] =>
  scrub(text)
    .segments.filter((segment) => segment.struck)
    .map((segment) => `${segment.struck}:${segment.text}`)

describe("scrubbing a feedback draft", () => {
  context("paths", () => {
    it("strikes a path under a home directory, on each OS", () => {
      expect(struck("It failed in ~/Workspace/app/src/a.ts at once.")).toEqual([
        "path:~/Workspace/app/src/a.ts",
      ])
      expect(struck("Opened /home/alice/Work/app.log, then /Users/bob/x.")).toEqual([
        "path:/home/alice/Work/app.log",
        "path:/Users/bob/x",
      ])
      expect(struck(String.raw`See C:\Users\Carol\AppData\Local\n.log.`)).toEqual([
        String.raw`path:C:\Users\Carol\AppData\Local\n.log`,
      ])
      expect(struck("cd /home/alice")).toEqual(["path:/home/alice"])
    })

    it("leaves a path's closing punctuation and quotes out", () => {
      expect(struck("(see `~/a/b.ts`), or ~/c.")).toEqual(["path:~/a/b.ts", "path:~/c"])
    })

    it("keeps repo-relative paths, system paths and urls", () => {
      const text =
        "frontend/toolkit/src/Toast.tsx and ./a/b.ts, /usr/bin/env, https://x.dev/home/alice/y"
      expect(scrub(text).total).toBe(0)
    })
  })

  context("names", () => {
    it("strikes the user and host of a shell prompt, leaving the @", () => {
      const scrubbed = scrub("alice@laptop:~/work$ pnpm test")
      expect(scrubbed.segments.map((segment) => `${segment.struck}:${segment.text}`)).toEqual([
        "user:alice",
        "null:@",
        "host:laptop",
        "null::",
        "path:~/work$",
        "null: pnpm test",
      ])
      expect(scrubbed.counts).toMatchObject({ user: 1, host: 1, path: 1 })
    })

    it("reads the bracketed and the bare prompt too", () => {
      expect(struck("[alice@laptop work]$ ls")).toEqual(["user:alice", "host:laptop"])
      expect(struck("alice@laptop $ ls")).toEqual(["user:alice", "host:laptop"])
    })

    it("does not take versions, tags and handles for names", () => {
      expect(scrub("pnpm@11.2 react@latest @moth @novadeck/core git@github.com:o/r").total).toBe(0)
    })
  })

  context("email addresses", () => {
    it("strikes an address", () => {
      expect(struck("Write to a.b+c@mail.example.org, please.")).toEqual([
        "email:a.b+c@mail.example.org",
      ])
    })

    it("keeps the mailboxes tools write for themselves", () => {
      expect(scrub("noreply@anthropic.com").total).toBe(0)
    })

    it("counts an address inside a path as the path", () => {
      expect(struck("/home/al/x@y.com")).toEqual(["path:/home/al/x@y.com"])
    })
  })

  it("counts by kind and says them", () => {
    const { counts } = scrub("~/a, ~/b, me@mail.dev")
    expect(counts).toEqual({ path: 2, user: 0, host: 0, email: 1 })
    expect(strikeSummary(counts)).toBe("2 home paths and 1 email address")
    expect(strikeSummary({ path: 1, user: 1, host: 1, email: 1 })).toBe(
      "1 home path, 1 user name, 1 host name and 1 email address",
    )
    expect(strikeSummary({ path: 1, user: 0, host: 0, email: 0 })).toBe("1 home path")
    expect(strikeSummary(scrub("nothing here").counts)).toBeNull()
  })

  context("the text to send", () => {
    it("puts a placeholder by kind where a part was struck", () => {
      expect(textToSend(scrub("It broke in ~/a/b.ts today."))).toBe("It broke in [path] today.")
      expect(textToSend(scrub("Mail me@mail.dev."))).toBe("Mail [email].")
      expect(textToSend(scrub("alice@laptop:~/w$ pnpm test"))).toBe(
        "[user]@[host]:[path] pnpm test",
      )
    })

    it("is the text itself where nothing is struck", () => {
      const text = "Plain\n\ntext, with frontend/ui/src/a.ts."
      expect(textToSend(scrub(text))).toBe(text)
      expect(scrub(text).segments).toEqual([{ text, struck: null }])
    })
  })

  context("other prompts and places", () => {
    it("reads zsh's and fish's prompts", () => {
      expect(struck("alice@Alices-MacBook-Pro ~ % ls")).toEqual([
        "user:alice",
        "host:Alices-MacBook-Pro",
      ])
      expect(struck("alice@host project % ls")).toEqual(["user:alice", "host:host"])
      expect(struck("alice@host ~/dir> ls")).toEqual(["user:alice", "host:host", "path:~/dir"])
    })

    it("strikes a Windows user name with spaces, up to the backslash", () => {
      expect(struck(String.raw`C:\Users\Alice Smith\proj`)).toEqual([
        String.raw`path:C:\Users\Alice Smith\proj`,
      ])
      expect(struck(String.raw`In C:\Users\alice and then D:\x`)).toEqual([
        String.raw`path:C:\Users\alice`,
      ])
    })

    it("strikes a Linux user name with spaces' first word at least", () => {
      expect(struck("/home/alice/My Projects/x")[0]).toBe("path:/home/alice/My")
    })

    it("reads file urls, Silverblue and WSL homes", () => {
      expect(struck("file:///home/alice/a.txt")).toEqual(["path:/home/alice/a.txt"])
      expect(struck("/var/home/alice/a")).toEqual(["path:/var/home/alice/a"])
      expect(struck("/mnt/c/Users/alice/a")).toEqual(["path:/mnt/c/Users/alice/a"])
      expect(scrub("$HOME %USERPROFILE% /root/x src/home/alice/y").total).toBe(0)
    })

    it("strikes the user and host of a remote login", () => {
      expect(struck("ssh alice@devbox")).toEqual(["user:alice", "host:devbox"])
      expect(struck("scp f.txt alice@host.example.com:/tmp")).toEqual([
        "user:alice",
        "host:host.example.com",
      ])
      expect(scrub("ssh git@github.com").total).toBe(0)
    })

    it("does not take a version for a domain", () => {
      expect(scrub("typescript@5.0.0-dev.ab pkg@1.2.3 @novadeck/core @moth").total).toBe(0)
    })
  })

  context("more shells and places", () => {
    it("reads Git Bash's and Kali's prompts", () => {
      expect(struck("alice@DESKTOP-ABC123 MINGW64 ~/work (main)")).toEqual([
        "user:alice",
        "host:DESKTOP-ABC123",
        "path:~/work",
      ])
      expect(struck("┌──(alice㉿kali)-[~]")).toEqual(["user:alice", "host:kali"])
    })

    it("reads WSL homes from both sides, with a spaced name", () => {
      expect(struck(String.raw`\\wsl$\Ubuntu\home\alice\x`)).toEqual([
        String.raw`path:\\wsl$\Ubuntu\home\alice\x`,
      ])
      expect(struck(String.raw`\\wsl.localhost\Ubuntu\home\alice\x`)).toHaveLength(1)
      expect(struck("/mnt/c/Users/Alice Smith/x")).toEqual(["path:/mnt/c/Users/Alice Smith/x"])
    })

    it("takes a login only where the command's arguments put it", () => {
      expect(scrub("ssh setup broke after I bumped pnpm@11.22.0 and react@18.3.1").total).toBe(0)
      expect(struck("ssh -p 22 -i key alice@devbox ls")).toEqual(["user:alice", "host:devbox"])
    })

    it("ends a spaced Windows name at a separator with more path after it", () => {
      expect(struck(String.raw`C:\Users\alice went home/ later`)).toEqual([
        String.raw`path:C:\Users\alice`,
      ])
    })
  })

  context("review pass 2", () => {
    it("strikes a spaced Windows name in a prompt", () => {
      expect(struck(String.raw`PS C:\Users\Alice Smith> ls`)).toEqual([
        String.raw`path:C:\Users\Alice Smith`,
      ])
      expect(struck(String.raw`C:\Users\Alice Smith>dir`)).toEqual([
        String.raw`path:C:\Users\Alice Smith`,
      ])
      expect(struck(String.raw`C:\Users\Alice Smith\ then`)[0]).toContain("Alice Smith")
      expect(struck(String.raw`C:\Users\alice went home/ later`)).toEqual([
        String.raw`path:C:\Users\alice`,
      ])
    })

    it("strikes emails with non-ASCII letters", () => {
      expect(struck("zoë@example.com")).toEqual(["email:zoë@example.com"])
      expect(textToSend(scrub("jürgen.müller@firma.de"))).toBe("[email]")
      expect(scrub("a@1.example.com").total).toBe(0)
    })

    it("reads ssh -l and wants a host that looks like one", () => {
      expect(struck("ssh -l alice devbox")).toEqual(["user:alice", "host:devbox"])
      expect(struck("ssh 9.6 alice@devbox")).toEqual(["user:alice", "host:devbox"])
      expect(scrub("ssh 9.6 pnpm@11.22.0").total).toBe(0)
    })
  })
})
