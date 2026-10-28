# Contributing

This workflow serves the repository owner and AI agents working for them. Write
issues and PRs so someone can pick them up without the conversation behind them.

## Issues

Search for an existing issue, then use the [issue form](.github/ISSUE_TEMPLATE/issue.yml).
Give the problem or goal a specific title. Say what happened, why it matters,
and what result would resolve it. For bugs, add steps to reproduce, expected and
actual results, environment details, and sanitized evidence. Mark guesses as
guesses.

When using a CLI or API, keep the form's headings and required fields. Read the
submitted issue back to catch formatting errors.

## Preparing Changes

Keep changes focused, follow branch and commit conventions, and preserve unrelated
work. Follow [CODING.md](CODING.md)
for code and tests, and [SECURITY.md](SECURITY.md) for sensitive work. Run the
relevant project checks; report results and anything you could not run. Update
documentation when behavior changes.

`pnpm format` and `pnpm lint` cover the relay's Rust in `backend/relay` too, as CI
does, and `pnpm lint` checks atlas's anchors (`pnpm --filter @novadeck/atlas check`).

The budgets of `backend/runner/src/terminals/manager.ts` only go down: `scripts/ratchet/manager.test.ts`
holds its lines and the methods of its `Terminals` class to the budgets in
`scripts/ratchet/manager.json`. Put new behaviour in a sibling module under `terminals/`,
and lower a budget when the test asks: it lets the file sit a little under its budget, and
fails once a change, such as an extraction, leaves it well under. A change that touches neither
`manager.ts` nor its budgets only prints what's wrong; the next change to them is held to it.

## Pull Requests

Use the [PR template](.github/pull_request_template.md), even when submitting
through a CLI or API. Titles use `type(optional-scope): concise imperative summary`.
Allowed types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`poc`, `revert`, `style`, and `test`.

Fill the required What, Why, and Impact sections. State the outcome, tradeoffs,
and remaining limits; mention checks run when useful. Link related issues; use a
closing keyword only when the PR fully resolves one. Remove instructional comments
and the Screenshot section when it does not apply. Keep the title and body current.

With `gh`, write the body to a Markdown file and pass `--body-file`. Read the
submitted PR back to confirm its title, body, base, and head branch.

Squash commits on `main` drive automated versioning. Use `fix`, `perf`, or
`build(deps)` for a patch release; `feat` for a minor release; and `!` or a
`BREAKING CHANGE` footer for a major release. Other allowed types do not publish
a release unless they declare a breaking change.

Every release from `main` is a prerelease, and the level counts from the latest
stable release: the first prerelease after it takes the step its commits call
for (once 1.0.0 is promoted, a `feat` makes 1.1.0), and later ones take the next patch
(1.1.1, 1.1.2) until a commit calls for a bigger step. Running the Release
workflow by hand with a version, such as 1.0.0, releases `main` as that version.

The `PR / Verify` job checks workflow syntax, title format, and required headings.
It checks heading presence, so the author must still write useful content. On
failure, read the job summary or step log for diagnostics and fixes. `FAIL` means
invalid content; `ERROR` means a check could not run; `SKIPPED` is not a pass.

## License

Novadeck is under [GPL-3.0-or-later](LICENSE). Before your first pull request can merge,
sign the [Contributor License Agreement](CLA.md): a bot comments on the pull request with a
link, and signing takes a GitHub sign-in and one click. You keep the copyright to your work.
The agreement also lets the maintainer license it on other terms, such as to companies, and
promises that whatever of yours ships in a public release is available as source under the GPL
or another OSI-approved license.
