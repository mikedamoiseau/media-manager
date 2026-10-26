import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import { PROFILE_COLORS, initial } from '../profiles.ts';
import { useStore, status, profileChoice, useProfile, toast } from '../store.ts';
import type { Profile } from '../types.ts';
import { IconClose } from './icons.tsx';

const tint = (color: string) => ({ '--c': color }) as CSSProperties;

/** A person's round initial, in their colour. */
export function Avatar({ profile, size }: { profile: Pick<Profile, 'name' | 'color'>; size?: 'big' }) {
  return (
    <span className={`avatar${size ? ` ${size}` : ''}`} style={tint(profile.color)} aria-hidden="true">
      {initial(profile.name)}
    </span>
  );
}

/** The new list, also on this device right away (the server tells every device too). */
function updated(profiles: Profile[]): Profile[] {
  status.set((s) => (s ? { ...s, profiles } : s));
  return profiles;
}

/**
 * Who's watching: shown until this device picks someone, and from the badge to switch. Picking is kept on
 * the device. `onClose`: opened from the badge (it can be closed without picking).
 */
export function WhosWatching({ onClose }: { onClose?: () => void }) {
  const st = useStore(status);
  const current = useStore(profileChoice);
  const [adding, setAdding] = useState(false);
  const profiles = st?.profiles;

  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (id: number) => {
    profileChoice.set(id);
    onClose?.();
  };

  return (
    <div className="whos" role="dialog" aria-modal="true" aria-labelledby="whos-title">
      {onClose && (
        <button className="icon-btn whos-close" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      )}
      <h1 id="whos-title">Who's watching?</h1>
      {!onClose && <p className="muted">Pick yourself once on this device. Your likes, suggestions and Continue watching stay yours.</p>}
      {!profiles ? (
        <p className="muted">Connecting to the media server…</p>
      ) : (
        <ul className="whos-list">
          {profiles.map((p) => (
            <li key={p.id}>
              <button className="whos-tile" aria-current={p.id === current || undefined} onClick={() => pick(p.id)}>
                <Avatar profile={p} size="big" />
                <span>{p.name}</span>
              </button>
            </li>
          ))}
          {!adding && (
            <li>
              <button className="whos-tile" onClick={() => setAdding(true)}>
                <span className="avatar big add" aria-hidden="true">+</span>
                <span>Add someone</span>
              </button>
            </li>
          )}
        </ul>
      )}
      {adding && profiles && (
        <ProfileForm
          used={profiles.map((p) => p.color)}
          onDone={(p) => {
            setAdding(false);
            if (p) pick(p.id);
          }}
        />
      )}
    </div>
  );
}

/** The badge in the top corner: who's watching on this device; a tap to switch. */
export function ProfileBadge() {
  const me = useProfile();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  return (
    <>
      <button className="avatar badge" style={tint(me.color)} onClick={() => setOpen(true)} aria-label={`${me.name} is watching: switch`}>
        {initial(me.name)}
      </button>
      {/* On the body: the page heads it sits in would keep it under the tab bar. */}
      {open && createPortal(<WhosWatching onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/**
 * Add someone (no profile given) or change a name and colour. A new profile starts on a colour nobody
 * uses yet. `onDone`: the profile once saved, or nothing when cancelled.
 */
export function ProfileForm({ profile, used = [], onDone }: { profile?: Profile; used?: string[]; onDone: (p?: Profile) => void }) {
  const [name, setName] = useState(profile?.name ?? '');
  const [color, setColor] = useState(profile?.color ?? PROFILE_COLORS.find((c) => !used.includes(c)) ?? PROFILE_COLORS[0]!);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="profile-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          const body = { name, color };
          const r = profile
            ? await api.put<{ profiles: Profile[] }>(`/api/profiles/${profile.id}`, body)
            : await api.post<{ profiles: Profile[] }>('/api/profiles', body);
          const list = updated(r.profiles);
          const saved = profile ? list.find((p) => p.id === profile.id) : list.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
          toast(profile ? `${name.trim()} saved` : `${name.trim()} added`);
          onDone(saved);
        } catch (err) {
          toast((err as Error).message, 'error');
          setSaving(false);
        }
      }}
    >
      <label>
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" autoFocus={!profile} maxLength={30} />
      </label>
      <fieldset>
        <legend>Colour</legend>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {PROFILE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              className="swatch"
              style={tint(c)}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </fieldset>
      <div className="form-actions">
        <button className="btn primary" disabled={saving || !name.trim()}>
          {profile ? 'Save' : 'Add'}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Settings: each profile, with Edit and Remove (a second tap removes it; the main one stays). */
export function ProfilesPanel() {
  const st = useStore(status);
  const [adding, setAdding] = useState(false);
  const profiles = st?.profiles ?? [];
  return (
    <section className="panel">
      <h2>Profiles</h2>
      <p className="muted">Each person's likes, suggestions and Continue watching. Who's watching is picked on each phone or iPad, with the round badge at the top.</p>
      <ul className="found">
        {profiles.map((p) => (
          <SavedProfile key={p.id} profile={p} used={profiles.map((x) => x.color)} />
        ))}
      </ul>
      {adding ? (
        <ProfileForm used={profiles.map((p) => p.color)} onDone={() => setAdding(false)} />
      ) : (
        <div className="tool-row">
          <button className="btn" onClick={() => setAdding(true)}>
            Add someone
          </button>
        </div>
      )}
    </section>
  );
}

function SavedProfile({ profile, used }: { profile: Profile; used: string[] }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    if (!confirm) return setConfirm(true);
    try {
      updated((await api.del<{ profiles: Profile[] }>(`/api/profiles/${profile.id}`)).profiles);
      toast(`${profile.name} removed`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (editing) {
    return (
      <li className="tv-edit">
        <ProfileForm profile={profile} used={used} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li>
      <span className="profile-row">
        <Avatar profile={profile} />
        <span>
          <strong>{profile.name}</strong>
          {profile.main && (
            <>
              <br />
              <span className="muted small">Main profile: also gets what's played with the TV remote</span>
            </>
          )}
        </span>
      </span>
      <span className="tv-actions">
        <button className="btn small" onClick={() => setEditing(true)}>
          Edit
        </button>
        {!profile.main && (
          <button className={`btn small${confirm ? ' danger' : ''}`} onClick={() => void remove()} onBlur={() => setConfirm(false)}>
            {confirm ? `Remove ${profile.name}?` : 'Remove'}
          </button>
        )}
      </span>
    </li>
  );
}
