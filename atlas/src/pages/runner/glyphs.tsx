import type { SqlVerb } from "../../lens-runner.ts"

export const verbName: Record<SqlVerb, string> = {
  read: "reads",
  write: "writes",
  delete: "deletes",
}

// One mark per verb, told apart by shape: a ring reads, a filled square writes, a cross
// deletes.
export const VerbGlyph = ({ verb, size = 11 }: { verb: SqlVerb; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 12 12"
    aria-label={verbName[verb]}
    className="shrink-0"
  >
    {verb === "read" ? (
      <circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
    ) : verb === "write" ? (
      <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1" fill="currentColor" />
    ) : (
      <path
        d="M2.6 2.6 9.4 9.4M9.4 2.6 2.6 9.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    )}
  </svg>
)

// A procedure as a tile: filled when SQL was reached, hollow and dashed when no store call
// was found; round when it streams.
export const Tile = ({
  traced,
  stream,
  size = 16,
}: {
  traced: boolean
  stream: boolean
  size?: number
}) => (
  <span
    aria-hidden
    className="relative block"
    style={{
      width: size,
      height: size,
      borderRadius: stream ? "50%" : 3,
      background: traced ? "var(--color-line-strong)" : "transparent",
      border: traced
        ? "1.5px solid var(--color-line-strong)"
        : "1.5px dashed var(--color-line-strong)",
    }}
  />
)
