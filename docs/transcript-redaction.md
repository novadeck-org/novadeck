# Redacting saved transcripts

A saved transcript (see `transcript` in `@novadeck/emulator/headless`) is the text that draws
a terminal's screen and scrollback again. Printed secrets must not stay in it, so the runner
masks them before it is kept. The rules are `@novadeck/secrets`' (`maskScreen`); this is how
the runner applies them.

## How

`terminals/transcriptRedaction.ts` (`redactTranscript`) works on the screen's cells, because a
transcript is styled text with line breaks, not rows:

1. The text is drawn on a scratch screen of the saved screen's size (`cols`, `rows`), with
   room for every line (`lines`).
2. Each line is read cell by cell into the string the rules see, with a map from the string's
   UTF-16 units to cells. A double-width character is one cell (its second half is skipped); a
   grapheme of several units is one cell; an empty cell reads as a space. A line that does not
   run to the edge is read without its trailing blanks.
3. `continues[y]` says a line runs on into the next: the next line is a soft wrap
   (`isWrapped`), or the line's last cell is filled (as `readScreen` has it). The union is
   used because a soft wrap can leave the last column empty (a wide character that did not
   fit), and a program can break a line by hand at the edge.
4. `maskScreen` says which units are secret. A cell is masked if any of its units is. With
   none masked the text is returned as it came.
5. Otherwise the text is drawn again on a screen with a row for every line (xterm's public API
   has no cell write, and a cursor cannot reach scrollback), and every masked cell is
   overwritten with `*`, one per column, in the cell's own colours and attributes. The cursor
   and pen are saved before (`ESC 7`) and restored after (`ESC 8`).
6. That screen is written out and drawn once more on a screen of the original size, and
   `transcript(screen, maxChars)` writes it out, so the limit cuts the oldest scrollback as it
   always does. The result is null when it does not fit at all.

## In a thread

`terminals/redaction.ts` runs it in a worker thread (`redactionWorker.ts`) on the runner's
`thread.ts`, which murmur's redaction shares (see [murmur.md](murmur.md)): the rules are many
regexes, and a thread that overruns its deadline is ended. A transcript that is not masked
(too slow, failed, no thread) is not kept: the result is null. One transcript at a time. The
desktop build adds the worker as the `redactionWorker` bundle entry beside `murmurWorker`, and
`apps/desktop/scripts/smoke.mjs` starts it from the packaged app.

## Time

Rows that run to the edge are read together: as one text from the group's first row, and from
each row's start as a window of 4096 characters (4 times the longest value a rule takes whole),
so the work on a group is bounded by a window for each row, not by all the rows after it.
Windows overlap, so a secret longer than one (6 KB of base64, a 3 KB JWT) is still masked
end to end, even after a row that ended in a word character.

On this machine (one core of a laptop, 120 columns, 40 rows, a transcript of about 250 KB),
through `redactTranscript`:

| Screen                            | Lines | Before the window | Now    |
| --------------------------------- | ----- | ----------------- | ------ |
| ordinary log lines, no secret     | 4001  | 0.05 s            | 0.05 s |
| 3000 lines each with two secrets  | 3001  | 0.3 s             | 0.3 s  |
| base64 in lines of 76             | 4493  | 0.24 s            | 0.24 s |
| hex dump drawn to the edge        | 2135  | 12.7 s            | 0.74 s |
| base64 on one 250 KB line         | 2135  | 11.4 s            | 0.66 s |
| `Ab1+` repeated on one line       | 2135  | 29.7 s            | 1.4 s  |
| `a=b ` repeated on one line       | 2135  | 33.4 s            | 1.2 s  |
| `a=b` without spaces, on one line | 2135  | 44.9 s            | 1.6 s  |
| `"a: ` repeated on one line       | 2135  | over 60 s         | 1.2 s  |

The deadline is 6 s: the worst case above with several times the headroom for a slower
machine, and still short enough that a stuck pattern costs one core for a few seconds.
