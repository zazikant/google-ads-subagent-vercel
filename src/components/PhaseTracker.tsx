import type { PhaseStatus, StageId } from '../lib/types';

interface BadgeProps {
  readonly text: string;
  readonly limit: number;
}

export function Badge({ text, limit }: BadgeProps) {
  const n = text?.length ?? 0;
  const ok = n <= limit;
  return (
    <span
      className={ok ? 'badge badge-ok' : 'badge badge-bad'}
      style={{ fontFamily: 'monospace' }}
    >
      {n}/{limit}
    </span>
  );
}

interface PhaseTrackerProps {
  readonly phases: ReadonlyArray<{ id: StageId; num: string; label: string; color: string; bg: string }>;
  readonly status: Record<StageId, PhaseStatus>;
  readonly text: Record<StageId, string>;
}

export function PhaseTracker({ phases, status, text }: PhaseTrackerProps) {
  return (
    <div className="phase-tracker">
      {phases.map((ph) => {
        const s = status[ph.id];
        const isDone = s === 'done';
        const isRun = s === 'running';
        const isIdle = s === 'idle';
        return (
          <div
            key={ph.id}
            className="phase"
            style={{
              borderColor: isDone ? ph.color + '88' : isRun ? ph.color : '#e5e7eb',
              background: isDone ? ph.bg : isRun ? ph.bg + '88' : '#fafafa',
              opacity: isIdle ? 0.55 : 1,
            }}
          >
            <div className="phase-head">
              <span
                className="phase-num"
                style={{ color: ph.color, background: ph.color + '22' }}
              >
                Phase {ph.num}
              </span>
              <span className="phase-label">{ph.label}</span>
              <span className="phase-icon">
                {isRun ? '⏳' : isDone ? '✅' : ''}
              </span>
            </div>
            {text[ph.id] && (
              <pre
                className="phase-text"
                style={{ borderColor: ph.color + '33' }}
              >
                {text[ph.id]}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
