/**
 * A shell command of several lines as cmd runs it, which runs only its first line: the lines are
 * joined with `&`, which runs each after the one before whatever that returned, as sh runs lines.
 * A blank line joins nothing. Undefined for one whose lines can't be joined so and mean the same:
 * a remark (`rem`, `@rem`, `rem.`, one after an `&` mid-line or as what `if`, `else` or `do` runs,
 * or behind the `;`, `,`, `=` and spaces cmd skips) or a label (`:x`, `::`, at a line's start or
 * after an `&`) would swallow every line after it, a `%` be expanded across the whole joined line
 * before any of it runs (`set N=1` then `echo %N%`, `%ERRORLEVEL%`), an odd `"` quote the joining
 * `&`, a trailing `^` escape it, a block (`if x (` … `)`) or a line ending or starting in `&`,
 * `&&`, `|` or `||` become a syntax error, and a continued line's indent be lost. `if` refuses a
 * `rem` anywhere after it, its argument as well as its body: refusing asks for one line, which
 * runs as written. (Probed on Antigravity's cmd shell mode, 2026-10-10, 1.2.14.)
 */
export const cmdJoined = (command: string): string | undefined => {
  const lines = command.split("\n").filter((line) => line.trim() !== "")
  if (lines.length < 2) return command.trim()
  const unjoinable = lines.some((line, at) => {
    const text = line.trim()
    return (
      /(^|[&|(])[\s;,=@]*(rem(\W|$)|:)/i.test(text) ||
      /\b(else|do)[\s;,=@]+rem(\W|$)/i.test(text) ||
      /(^|[&|(])[\s;,=@]*if\b.*[\s;,=@]rem(\W|$)/i.test(text) ||
      text.includes("%") ||
      // A `^"` is a quote cmd prints, which opens nothing.
      (text.replaceAll('^"', "").match(/"/g) ?? []).length % 2 === 1 ||
      /[\^(&|]$/.test(text) ||
      /^[)&|]/.test(text) ||
      (at > 0 && lines[at - 1]!.trimEnd().endsWith("^"))
    )
  })
  return unjoinable ? undefined : lines.map((line) => line.trim()).join(" & ")
}
