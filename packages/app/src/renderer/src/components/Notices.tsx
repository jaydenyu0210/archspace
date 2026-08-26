/**
 * Transient messages, dismissed by clicking them.
 *
 * Deliberately not a modal and deliberately not auto-dismissing. These carry
 * things the user did not ask about — a save failed, an engine restarted, a
 * config file had issues — and a modal would interrupt work over something
 * that is often informational, while a timeout would hide the one message
 * someone stepped away mid-run to miss. Clicking is the whole interaction.
 */
import { useStore } from '../store';

export function Notices() {
  const notices = useStore((s) => s.notices);
  const dismiss = useStore((s) => s.dismissNotice);
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.kind}`} onClick={() => dismiss(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
