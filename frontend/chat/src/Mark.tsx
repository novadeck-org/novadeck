// The person's mark in the gutter: Novadeck's block cursor, drawn, so it is the same shape in
// every font. It stands still. Hollow, it marks a prompt that isn't theirs: the doorbell's.
export const Mark = ({ hollow = false }: { readonly hollow?: boolean }): React.JSX.Element => (
  <span className="chat-mark" data-hollow={hollow || undefined} aria-hidden />
)
