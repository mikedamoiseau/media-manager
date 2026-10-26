import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { api } from '../api.ts';
import { useStore, typingForKodi, toast, useTv } from '../store.ts';
import type { KodiInput } from '../types.ts';
import { Sheet } from './Sheet.tsx';

/** The phone keyboard that suits what Kodi asks for. */
function fieldFor(type: string): InputHTMLAttributes<HTMLInputElement> {
  switch (type) {
    case 'password':
      return { type: 'password' };
    case 'numericpassword':
      return { type: 'password', inputMode: 'numeric' };
    case 'number':
    case 'seconds':
      return { inputMode: 'numeric' };
    case 'ip':
      return { inputMode: 'decimal' };
    case 'date':
      return { inputMode: 'numeric', placeholder: 'DD/MM/YYYY' };
    case 'time':
      return { inputMode: 'numeric', placeholder: 'HH:MM' };
    default:
      return { type: 'text' };
  }
}

/**
 * When Kodi shows its on-screen keyboard, the phone's keyboard comes up instead, on any screen.
 * Also opened from the Remote's Keyboard button.
 */
export function KodiKeyboard() {
  const tv = useTv();
  const manual = useStore(typingForKodi);
  // Only the keyboard of the TV this device controls.
  const input = tv?.input ?? null;
  const key = input && `${tv!.id}:${input.id}`;
  // Closed on the phone, but Kodi may still wait (finish it with the TV remote).
  const [hidden, setHidden] = useState<string | null>(null);
  if (!(manual || (key && key !== hidden))) return null;
  const done = () => {
    if (key) setHidden(key);
    typingForKodi.set(false);
  };
  return <KeyboardSheet key={key ?? 'manual'} input={input} onDone={done} />;
}

function KeyboardSheet({ input, onDone }: { input: KodiInput | null; onDone: () => void }) {
  const field = fieldFor(input?.type ?? 'keyboard');
  const [text, setText] = useState(input && field.type !== 'password' ? input.value : '');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  // After the sheet takes focus. iOS only brings up the keyboard from a tap, so there it waits for one.
  useEffect(() => {
    const t = setTimeout(() => ref.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  const send = async () => {
    setSending(true);
    try {
      await api.post('/api/kodi/input', { text });
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
      setSending(false);
    }
  };

  const cancelOnTv = () => {
    onDone();
    api.post('/api/kodi/remote', { action: 'back' }).catch((e: Error) => toast(e.message, 'error'));
  };

  return (
    <Sheet title={input?.title || 'Type on the TV'} onClose={onDone}>
      <form
        className="kodi-keyboard"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={ref}
          {...field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={input?.title || 'Text for Kodi'}
          enterKeyHint="send"
          autoComplete="off"
          maxLength={1000}
        />
        {!input && <p className="muted small">Goes into Kodi’s keyboard: open a search or a text field on the TV first.</p>}
        <div className="tool-row">
          {input && (
            <button type="button" className="btn" onClick={cancelOnTv}>
              Cancel on TV
            </button>
          )}
          <button className="btn primary" disabled={sending}>
            Send
          </button>
        </div>
      </form>
    </Sheet>
  );
}
