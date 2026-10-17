// An optional peer the app never installed: the browser bundle can't resolve it.
// @ts-expect-error The package is missing on purpose.
export { peer } from "missing-optional-peer"
