import { InboxIcon } from './icons';

interface Props {
  text: string;
  hint?: string;
}

export default function EmptyState({ text, hint }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <InboxIcon />
      </span>
      <p className="empty-state-text">{text}</p>
      {hint && <span className="empty-state-hint">{hint}</span>}
    </div>
  );
}