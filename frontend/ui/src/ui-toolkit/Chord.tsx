// A shortcut as keycaps, one per key, as the rest of the app shows keys.
export const Chord = ({ keys }: { readonly keys: readonly string[] }): React.JSX.Element => (
  <>
    {keys.map((key) => (
      <kbd key={key}>{key}</kbd>
    ))}
  </>
)
