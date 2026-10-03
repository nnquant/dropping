import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, HardDrive } from 'lucide-react';
import { useDismiss } from './useDismiss';

export type Crumb = { label: string; path: string };

const DRIVE = /^[A-Za-z]:/;

/** Splits a local Windows, UNC or POSIX path into clickable ancestors, keeping its own separator style. */
export function breadcrumbs(path: string): Crumb[] {
  if (!path) return [];
  const separator = path.includes('\\') ? '\\' : '/';
  const crumbs: Crumb[] = [];
  let current = '';
  let rootLength = 0;
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(path);
  if (unc) {
    current = unc[0];
    rootLength = current.length;
    crumbs.push({ label: current, path: current });
  } else if (DRIVE.test(path)) {
    current = path.slice(0, 2) + separator;
    rootLength = 2;
    crumbs.push({ label: path.slice(0, 2), path: current });
  } else if (path.startsWith('/')) {
    current = '/';
    rootLength = 1;
    crumbs.push({ label: '/', path: current });
  }
  for (const part of path.slice(rootLength).split(/[\\/]/).filter(Boolean)) {
    current = !current || current.endsWith(separator) ? current + part : current + separator + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

/** A bare drive letter ("d:") means that drive's root, as in Explorer. */
export const normalizeTypedPath = (value: string) => /^[A-Za-z]:$/.test(value) ? `${value.toUpperCase()}\\` : value;

interface AddressBarProps {
  path: string;
  label: string;
  disabled: boolean;
  onNavigate: (path: string) => void;
  /** Lists local drive roots; when given and the path is on a drive, the root becomes a drive switcher. */
  listDrives?: () => Promise<string[]>;
}

export default function AddressBar({ path, label, disabled, onNavigate, listDrives }: AddressBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const [overflowing, setOverflowing] = useState(false);
  const [drives, setDrives] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const driveRef = useRef<HTMLDivElement>(null);
  const crumbs = useMemo(() => breadcrumbs(path), [path]);
  const driveRoot = listDrives && DRIVE.test(path) ? crumbs[0] : undefined;
  const trail = driveRoot ? crumbs.slice(1) : crumbs;
  const closeDrives = useCallback(() => setDrives(null), []);
  useDismiss(driveRef, drives !== null, closeDrives);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  // Long paths keep their deepest folders in view, like Explorer.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollLeft = track.scrollWidth;
    setOverflowing(track.scrollWidth > track.clientWidth);
  }, [crumbs, editing]);

  const startEditing = () => {
    if (disabled) return;
    setDraft(path);
    setEditing(true);
  };
  const toggleDrives = async () => {
    if (drives) { setDrives(null); return; }
    const roots = await listDrives?.().catch(() => []) ?? [];
    setDrives(roots.length ? roots : driveRoot ? [driveRoot.path] : []);
  };

  if (editing) {
    return (
      <form className="address is-editing" onSubmit={event => {
        event.preventDefault();
        const next = normalizeTypedPath(draft.trim());
        setEditing(false);
        if (next) onNavigate(next);
      }}>
        <input ref={inputRef} aria-label={label} value={draft} spellCheck={false}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }} />
      </form>
    );
  }

  return (
    <div className={`address ${disabled ? 'is-disabled' : ''}`} aria-label={label} title={path} role="group">
      {driveRoot && (
        <div className="address-drive" ref={driveRef} onKeyDown={event => { if (event.key === 'Escape' && drives) { event.preventDefault(); event.stopPropagation(); setDrives(null); } }}>
          <button type="button" className={`address-crumb ${drives ? 'is-open' : ''}`} aria-label={`切换磁盘，当前 ${driveRoot.label}`} aria-haspopup="menu" aria-expanded={drives !== null} disabled={disabled} onClick={() => void toggleDrives()}>
            <HardDrive size={12} />{driveRoot.label}<ChevronDown size={11} />
          </button>
          {drives && (
            <div className="address-menu" role="menu" aria-label="磁盘">
              {drives.map(drive => {
                const current = drive.slice(0, 2).toUpperCase() === driveRoot.label.toUpperCase();
                return (
                  <button key={drive} type="button" role="menuitem" className={current ? 'is-current' : ''} onClick={() => { setDrives(null); onNavigate(drive); }}>
                    <HardDrive size={13} /><span>{drive.slice(0, 2)}</span>{current && <Check size={13} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className={`address-crumbs ${overflowing ? 'is-overflowing' : ''}`} ref={trackRef}>
        {trail.map((crumb, index) => (
          <Fragment key={crumb.path}>
            {(index > 0 || driveRoot) && <ChevronRight size={12} className="address-separator" aria-hidden="true" />}
            <button type="button" className={`address-crumb ${index === trail.length - 1 ? 'is-current' : ''}`} disabled={disabled} onClick={() => onNavigate(crumb.path)}>
              {crumb.label}
            </button>
          </Fragment>
        ))}
      </div>
      <button type="button" className="address-edit" aria-label="编辑路径" title="编辑路径" disabled={disabled} onClick={startEditing} />
    </div>
  );
}
