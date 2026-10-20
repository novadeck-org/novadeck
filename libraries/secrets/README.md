# @novadeck/secrets

Finds secrets in terminal text by their shape and masks them. The
rules are fixed: nothing is learned or configured, so the same text is masked the same on every
machine. Pure JavaScript, for Node and the browser alike.

## Subpaths

- `.`: everything below.

## Parts

- `redact(text)`: the text with each secret written as `[redacted]` (`redacted`); a run of
  secrets with only newlines between them is one mask.
- `redactAs(placeholder)`: a `redact` that writes `placeholder` instead.
- `redactScreen(rows, continues)`: a screen's rows with their secrets masked, one row out for
  each row in. `continues[i]` says row `i` runs to the pane's edge and goes on in the next: such
  rows are read on their own and together: as one text from the first row of the group, and
  from each row's start as many rows on as add up to 4096 characters (a window, 4 times the
  longest value a rule takes whole). A secret split across them is masked on both sides, a
  longer one by the windows that overlap along it, and the work grows with the rows, not with
  their square. A key block masks every row it covers, to the end of the screen when its end is not
  on it.
- `maskScreen(rows, continues)`: the same reading as `redactScreen`, but returning which UTF-16
  units of each row are secret, one array of flags per row as long as the row, for a caller that
  masks the cells themselves and keeps the screen's shape.
- `maskedSpans(text)`: the pieces of the text `redact` masks, for a check on what it masked.

## What the rules find

- Provider keys and tokens by their prefixes (`sk-`, `sk_live_`, `ghp_`, `github_pat_`,
  `glpat-`, `hf_`, `hvs.`, `npm_`, `pypi-`, `AIza`, `ya29.`, `AKIA`, `xox`, `SG.`,
  `AGE-SECRET-KEY-`), each once long enough to be one, Discord bot tokens and JWTs. Key blocks
  (`-----BEGIN … -----`) are masked whole, or to the end of the text when their end is cut off.
- `Authorization`, `Cookie` and bearer values, webhook URLs, URLs with `user:password@` (an
  empty user too) and secret query parameters.
- `NAME=value`, `name: value` and `"name": "value"` (a JSON string inside a string too) when
  the name sounds secret, `set -x NAME value`, exact secret flags (`--password`, `--token`,
  `--api-key`, ...), and command lines that take a password their own way: `mysql -p`,
  `docker login -p`, `sshpass -p`, `redis-cli -a`, `htpasswd -b`, `openssl -k`/`-pass` and
  `curl -u`.
  - A name sounds secret by its words: `secret`, `password` (and Polish `hasło`), `token`,
    `pass`, `pwd`, an `api`, `private` or `access` before `key`, and so on. `KEY_COUNT`,
    `token_count`, `PRIMARY_KEY`, `auth=required`, `sessionId` and `--sort-key` are not secrets.
    Values that are paths, short numbers, words like `true` or code that reads a secret from
    elsewhere (`process.env.X`, `$TOKEN`) are kept.
- Long hex or base64 runs. Base64 never matches inside a path, and needs digits, mixed case and
  no long word, so identifiers and paths survive. Commit ids (40 hex) and `sha256:` digests are
  kept.

## Limits

A token cut short, as by a text cut to size before it is redacted, may no longer be long
enough to look like one: cut a text after redacting it.

It finds secrets by their shape, so a secret with neither a known prefix, a name that sounds
secret beside it, nor the look of a long key (a bare password on a line of its own, an
in-house token format) is kept. On a narrow pane a group of wrapped rows that redacts
differently as one is masked whole, so a neighbouring row can go with a secret; a quote left
open across rows that did not run to the edge is not followed.

Nothing bounds a single reading: the rules are many regexes, so a caller with a deadline runs them in
a worker, where a stuck one can be ended.
