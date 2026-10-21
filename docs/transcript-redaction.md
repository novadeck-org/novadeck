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
   double-width `＊` for a double-width character, so a masked text is no longer than the text it came from (a grapheme of several characters
   becomes one `*`, so it can be shorter). The cursor
   and pen are saved before (`ESC 7`) and restored after (`ESC 8`).
6. That screen is written out and drawn once more on a screen of the original size, whose line
   count and cursor are set to the original's (the screen with a row for every line writes a
   cursor on a blank last row as moves, which draw no row), and `transcript(screen, maxChars)`
   writes it out. The result has the shape of the text it came from, and the limit cuts the
   oldest scrollback as it always does. It is empty (nothing to keep) when not even the visible
   rows fit; only a failure of the work is null. A cursor at the very edge of a row, about to
   wrap, is put back by printing the row's last character again; the result is never longer
   than the text. The cursor can still land a column to the left, as when it was moved back
   off a full last row, and the pen left at the end can differ: restoring resets both before
   it draws anything, so neither shows.

## In a thread

`terminals/redaction.ts` runs it in a worker thread (`redactionWorker.ts`) on the runner's
`thread.ts`, which murmur's redaction shares (see [murmur.md](murmur.md)): the rules are many
regexes, and a thread that overruns its deadline is ended. A transcript that is not masked
(too slow, failed, no thread) is not kept: the result is null. One transcript at a time.
What is masked is then sealed (`terminals/sealing.ts`) before it is saved, and not taken at
all until the key has come. The desktop build adds the worker as the `redactionWorker`
bundle entry beside `murmurWorker`, and `apps/desktop/scripts/smoke.mjs` starts it from the
packaged app.

## What it masks, and what it does not

Rows that run to the edge are read together: as one text from the group's first row, and from
each row's start as a window of 4096 characters (4 times the longest value a rule takes whole),
so the work on a group is bounded by a window for each row, not by all the rows after it.

- A secret a rule can see whole in a window is masked. A mask that fills most of a window
  (2048 characters or more) and runs to its end goes on through the characters a token is made
  of; a short one that happens to end where a window does is not carried on.
- A token with a prefix (`eyJ`, `sk-`, `ghp_`, `github_pat_`, `glpat-`, `hf_`, `hvs.`, `npm_`,
  `pypi-`, `ya29.`, `AIza`, `SG.`, `xox?-`, `AGE-SECRET-KEY-1`) followed by 2048 characters or
  more of token characters, at the start of a row or after a boundary, is masked to the end of
  its run, whatever its length. This also masks a base64 JSON blob after `data:…;base64,`
  (an inline source map is one), which the flat `redact()` leaves alone: base64 JSON can be a
  credential, so a transcript keeps none of it.
- A long run of base64 is judged by its pieces of 20 characters: from four pieces (80
  characters) on it is a key if at most a third of the pieces fail to look like one (a word in
  them, one case of letter) and digits are a twentieth of it or more (random base64 has one in
  six; identifiers almost none). So a stray run of seven lowercase letters does not leave a
  part of a long random key visible. Mangled C++ and Rust names (`_Z…`, `_R…`, with no `-`,
  `+`, `/` or `=` in them) are judged by the stricter rule alone, as before it, which still
  masks the ones with no seven lowercase letters in a row.
  Measured with random bytes, a run still escapes about 1 in 140 at 100 characters and 1 in
  2,000 at 400; and short ones, 40 to 80 characters, about 1 in 20, nearly all of them (about
  90%) because of a run of seven lowercase letters, and about 3% because a slash between two
  short lowercase stretches reads as a path.
- Not masked: what the rules do not find by shape (a bare password on a line by itself, an
  in-house token format), a secret split by something other than a line wrap (a cursor
  move, a spinner redraw), and a secret in the alternate screen, which is not in the
  transcript.

## Time

On this machine (one core of a laptop), through `redactTranscript`, for a transcript as
saving hands it over: the whole scrollback (1000 lines and the screen), cut to 256 KiB. The
first columns are 120 × 40 (about 125 KB of text), the last 500 × 100 (about 550 KB):

| Screen                               | 120 × 40 | 500 × 100 |
| ------------------------------------ | -------- | --------- |
| ordinary log lines                   | 0.03 s   | 0.04 s    |
| 1100 lines each with two secrets     | 0.09 s   | 0.14 s    |
| hex dump drawn to the edge           | 0.34 s   | 0.86 s    |
| base64 on one line                   | 0.44 s   | 0.97 s    |
| `Ab1+` repeated on one line          | 0.61 s   | 1.2 s     |
| `a=b` without spaces, on one line    | 0.66 s   | 1.0 s     |
| `"a: ` repeated on one line          | 0.49 s   | 0.77 s    |
| `sk-` repeated on one line           | 0.60 s   | 1.1 s     |
| `-hf_` or `eyJ` repeated on one line | 0.23 s   | 0.7 s     |

Before the window a 250 KB hex dump took 12.7 s, base64 on a line 11.4 s, `Ab1+` 29.7 s and
`a=b` without spaces 44.9 s (the work grew with the square of the rows). Before the long-token
pass skipped runs it had masked, `sk-` repeated took 5.4 s at 250 KB and 17 s at 500 KB.

The deadline is 6 s: the worst case above with several times the headroom for a slower
machine, and still short enough that a stuck pattern costs one core for a few seconds.
