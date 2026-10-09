import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useDismiss } from './useDismiss';

export type ContextAction = {
  label: string; icon: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean;
  checked?: boolean; onClick: () => void;
};
type Props = { x: number; y: number; label: string; items: (ContextAction | null)[]; onClose: (restoreFocus?: boolean) => void };

export default function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useDismiss(ref, true, () => onClose());
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = () => onClose();
    const onScroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="context-menu" role="menu" aria-label={label} style={position}
      onContextMenu={event => event.preventDefault()} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true); return; }
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); buttons[event.key === 'Home' ? 0 : buttons.length - 1].focus();
        }
      }}>
      {items.map((item, index) => item ? (
        <button key={item.label} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked}
          className={item.danger ? 'danger' : ''} disabled={item.disabled} tabIndex={-1}
          onClick={() => { onClose(true); item.onClick(); }}>
          {item.icon}<span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}{item.checked && <Check size={13} />}
        </button>
      ) : <div role="separator" className="context-separator" key={`separator-${index}`} />)}
    </div>, document.body,
  );
}
