// The count over the bell. The bell holds `data-project-status`, whose tone the dot takes
// (see project-status.css).
export const NotificationBadge = ({ text }: { text: string }): React.JSX.Element => (
  <span aria-hidden="true" className="project-status-dot notification-badge">
    <span className="notification-badge-count">{text}</span>
  </span>
)
