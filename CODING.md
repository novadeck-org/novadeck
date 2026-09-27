# Coding Style

Good code lets a reader find a behavior, understand it, and change it without
learning the whole system first. Start with the domain: group files by what they
do, keep a function beside the types that describe it, and place its `*.test.ts`
beside the source. Add a shallow folder when it makes a domain boundary easier to
see. A shared `utils` folder rarely tells a reader where to look.

Give each function one job. Rules and transformations should be pure whenever
possible; network calls, storage, and other effects belong at the edges. Validate
outside data there, and make failures explicit. Early returns keep the main path
visible, while a new function is often clearer than another level of nesting.

In the UI, state lives in the workspace and UI stores. Put the pure transition
beside the type it changes, as `shell/shell-state.ts` and
`terminals/rename-state.ts` do, and let commands in `app/commands/` read the
latest stores and reach the page only through the effects they are given.
Components subscribe to the narrowest selection they render; see the README's
"Working on the UI" for the layers.

Prefer `const` and treat values as immutable. Derive a new value instead of
changing one that other code may hold. Use short, single-word names such as
`file` or `result` when the context makes them clear, and longer names when it
doesn't. Precise TypeScript types should make inputs, outputs, and errors easy
to follow without a trail of casts.

Tests should read like accounts of behavior. Use `*.test.ts` for colocated tests
and `*.spec.tsx` for UI behaviour specs in `application/ui/src/specs/`. Name
groups after what they test and cases after the behavior being checked. In
`application/runner`, use top-level `describe` groups and direct `it` cases,
without nested `describe` or `context` layers. Elsewhere, use `describe`,
`context`, and `it` to show the situation and its observable result.
Use fixtures for stable examples and mock as little as possible. Test commands
and key routing as plain functions: `test/commands.ts` runs the real stores,
navigator, and commands with effects that record what they would do. When a test
needs an HTTP API, use MSW; exercise real functions and boundaries instead of
mocking `fetch` or internal calls. If a build changes what consumers receive,
test the built artifact too.

Apply this style to new code and improve existing code as you touch it. Run the
relevant project checks before handing off a change, and say which checks could
not run.
