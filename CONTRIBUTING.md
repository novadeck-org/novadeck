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

`pnpm format` and `pnpm lint` cover the relay's Rust in `application/relay` too, as CI
does.

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

The `PR / Verify` job checks workflow syntax, title format, and required headings.
It checks heading presence, so the author must still write useful content. On
failure, read the job summary or step log for diagnostics and fixes. `FAIL` means
invalid content; `ERROR` means a check could not run; `SKIPPED` is not a pass.
