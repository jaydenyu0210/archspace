/**
 * Transient messages, dismissed by clicking them.
 *
 * Deliberately not a modal, and dismissed by severity. These carry things the
 * user did not ask about — a save failed, an engine restarted, a config file
 * had issues — and a modal would interrupt work over something that is often
 * informational, while a timeout on a warning or an error would hide the one
 * message someone stepped away mid-run to miss.
 *
 * So `info` expires on its own and everything else waits to be clicked. This
 * file used to say no notice auto-dismissed at all, while `notify` timed out
 * all three — which made the reasoning above false for exactly the messages it
 * was written about.
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
