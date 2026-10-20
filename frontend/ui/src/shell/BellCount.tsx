// The count over the Inbox's bell. The bell holds `data-project-status`, whose tone the dot takes
// (see project-status.css).
export const BellCount = ({ text }: { text: string }): React.JSX.Element => (
  <span aria-hidden="true" className="project-status-dot bell-count">
    <span className="bell-count-text">{text}</span>
  </span>
)
