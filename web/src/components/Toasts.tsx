import { useStore, toasts } from '../store.ts';

export function Toasts() {
  const list = useStore(toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'error' ? ' is-error' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
