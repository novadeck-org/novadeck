# Coding Style

Good code lets a reader find a behavior, understand it, and change it without
learning the whole system first. Start with the domain: group files by what they
do, keep a function beside the types that describe it, and place its test file
beside the source. Add a shallow folder when it makes a domain boundary easier to
see. A shared `utils` folder rarely tells a reader where to look.

Give each function one job. Rules and transformations should be pure whenever
possible; network calls, storage, and other effects belong at the edges. Validate
outside data there, and make failures explicit. Early returns keep the main path
visible, while a new function is often clearer than another level of nesting.

Prefer `const` and treat values as immutable. Derive a new value instead of
changing one that other code may hold. Use short, single-word names such as
`file` or `result` when the context makes them clear, and longer names when it
doesn't. Precise TypeScript types should make inputs, outputs, and errors easy
to follow without a trail of casts.

Tests should read like accounts of behavior. In `application/runner`, use
`*.test.ts` with top-level `describe` groups and direct `it` cases. Name groups
after what they test and cases after the behavior being checked; avoid nested
`describe` or `context` layers. Elsewhere, keep `*.spec.ts` with `describe`,
`context`, and `it` to show the situation and its observable result.
Use fixtures for stable examples and mock as little as possible. When a test
needs an HTTP API, use MSW; exercise real functions and boundaries instead of
mocking `fetch` or internal calls. If a build changes what consumers receive,
test the built artifact too.

Apply this style to new code and improve existing code as you touch it. Run the
relevant project checks before handing off a change, and say which checks could
not run.
