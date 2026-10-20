# Redacting saved transcripts

A saved transcript (see `transcript` in `@novadeck/emulator/headless`) is the text that draws
a terminal's screen and scrollback again. Printed secrets must not stay in it, so the runner
masks them before it is kept. The rules are `@novadeck/secrets`' (`maskScreen`); this is how
the runner applies them.

## How

`terminals/transcriptRedaction.ts` (`redactTranscript`) works on the screen's cells, because a
transcript is styled text with line breaks, not rows:

1. The text is drawn on a scratch screen of the saved screen's size (`cols`, `rows`), with
   room for every line (`lines`). It may be more than `maxChars`: the whole of a screen's
   scrollback. The secrets are found before anything is cut.
2. Each line is read cell by cell into the string the rules see, with a map from the string's
   UTF-16 units to cells. A double-width character is one cell (its second half is skipped); a
   grapheme of several units is one cell; an empty cell reads as a space. A line that does not
   run to the edge is read without its trailing blanks; one that wraps into the next is read
   to its last cell that holds anything, so the empty last cell a double-width character that
   did not fit leaves does not split a value.
3. `continues[y]` says a line runs on into the next: the next line is a soft wrap
   (`isWrapped`), or the line's last cell is filled (as `readScreen` has it). The union is
   used because a soft wrap can leave the last column empty (a wide character that did not
   fit), and a program can break a line by hand at the edge.
4. `maskScreen` says which units are secret. A cell is masked if any of its units is. With
   none masked, the text is returned as it came, or cut to `maxChars` if it is longer.
5. Otherwise the text is drawn again on a screen with a row for every line (xterm's public API
   has no cell write, and a cursor cannot reach scrollback), and every masked cell is
   overwritten in the cell's own colours and attributes: with `*`, or with the one
   double-width `＊` for a double-width character, so the text keeps its length. The cursor
   and pen are saved before (`ESC 7`) and restored after (`ESC 8`).
6. That screen is written out and drawn once more on a screen of the original size, whose line
   count and cursor are set to the original's (the screen with a row for every line writes a
   cursor on a blank last row as moves, which draw no row), and `transcript(screen, maxChars)`
   writes it out. The result has the shape of the text it came from, and the limit cuts the
   oldest scrollback as it always does. It is null when not even the visible rows fit.

## In a thread

`terminals/redaction.ts` runs it in a worker thread (`redactionWorker.ts`) on the runner's
`thread.ts`, which murmur's redaction shares (see [murmur.md](murmur.md)): the rules are many
regexes, and a thread that overruns its deadline is ended. A transcript that is not masked
(too slow, failed, no thread) is not kept: the result is null. One transcript at a time. The
desktop build adds the worker as the `redactionWorker` bundle entry beside `murmurWorker`, and
`apps/desktop/scripts/smoke.mjs` starts it from the packaged app.

## What it masks, and what it does not

Rows that run to the edge are read together: as one text from the group's first row, and from
each row's start as a window of 4096 characters (4 times the longest value a rule takes whole),
so the work on a group is bounded by a window for each row, not by all the rows after it.

- A secret a rule can see whole in a window is masked. A mask that reaches a window's end goes
  on through the characters a token is made of.
- A token with a prefix (`eyJ`, `sk-`, `ghp_`, `github_pat_`, `glpat-`, `hf_`, `hvs.`, `npm_`,
  `pypi-`, `ya29.`, `AIza`, `SG.`, `xox?-`, `AGE-SECRET-KEY-1`) followed by 2048 characters or
  more of token characters, at the start of a row or after a boundary, is masked to the end of
  its run, whatever its length.
- A long run of base64 is judged by its pieces of 20 characters: it is a key if at most a
  third of them fail to look like one (a word in them, one case of letter), and digits are a
  twentieth of it or more. The odd run of
  seven lowercase letters in random base64 no longer leaves a part of it visible. Runs of 100
  to 400 characters still escape now and then (about 1 in 3000 for 300 random bytes), as do
  short ones (40 to 80 characters, about 1 in 20): a slash between two short lowercase
  stretches reads as a path.
- Not masked: what the rules do not find by shape (a bare password on a line by itself, an
  in-house token format), a secret split by something other than a line wrap (a cursor
  move, a spinner redraw), and a secret in the alternate screen, which is not in the
  transcript.

## Time

On this machine (one core of a laptop, 120 columns, 40 rows, a transcript of about 250 KB),
through `redactTranscript`:

| Screen                            | Lines | Before the window | Now    |
| --------------------------------- | ----- | ----------------- | ------ |
| ordinary log lines, no secret     | 4001  | 0.05 s            | 0.04 s |
| 3000 lines each with two secrets  | 3001  | 0.3 s             | 0.3 s  |
| base64 in lines of 76             | 4493  | 0.24 s            | 0.24 s |
| hex dump drawn to the edge        | 2135  | 12.7 s            | 0.64 s |
| base64 on one 250 KB line         | 2135  | 11.4 s            | 0.9 s  |
| `Ab1+` repeated on one line       | 2135  | 29.7 s            | 1.2 s  |
| `a=b ` repeated on one line       | 2135  | 33.4 s            | 1.2 s  |
| `a=b` without spaces, on one line | 2135  | 44.9 s            | 1.5 s  |
| `"a: ` repeated on one line       | 2135  | over 60 s         | 1.2 s  |

The deadline is 6 s: the worst case above with several times the headroom for a slower
machine, and still short enough that a stuck pattern costs one core for a few seconds.
