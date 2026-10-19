// A small ring for work in a tight place, such as the footer: filled to `percent` of a turn,
// or turning while there is nothing to count (`percent` null). Decorative: the words beside
// it say how far the work is.
export const ProgressRing = ({
  percent,
  size = 12,
}: {
  readonly percent: number | null
  readonly size?: number
}): React.JSX.Element => {
  const radius = 5
  const circumference = 2 * Math.PI * radius
  return (
    <svg
      className="progress-ring"
      data-state={percent === null ? "indeterminate" : "loading"}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <circle className="progress-ring-track" cx="6" cy="6" r={radius} />
      <circle
        className="progress-ring-range"
        cx="6"
        cy="6"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (percent ?? 25) / 100)}
      />
    </svg>
  )
}
