import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Check, CircleAlert, Laptop, Plus, RefreshCw, Search, Server, Trash2, Unplug } from 'lucide-react';
import type { Connection, SshConfigHost } from './types';
import { useDismiss } from './useDismiss';

type SavedProfile = { name: string; host: string; port: number; username: string };
type Item = {
  key: string; title: string; detail: string; kind: Connection['kind'];
  state: ReactNode; current: boolean; warning?: string | null; select: () => void;
  action?: { label: string; icon: ReactNode; run: () => void };
};
type Section = { key: string; title: string; items: Item[]; extra?: ReactNode; notes?: ReactNode };
export type PickerTrigger = (args: { open: boolean; toggle: () => void; ref: Ref<HTMLButtonElement> }) => ReactNode;

interface DevicePickerProps {
  /** Names the panel ("选择{label}"). */
  label: string;
  trigger: PickerTrigger;
  current?: Connection;
  otherConnectionId: string;
  connections: Connection[];
  configHosts: SshConfigHost[];
  configPath: string;
  configLoading: boolean;
  configError: string | null;
  configWarnings: string[];
  profiles: SavedProfile[];
  isHostLive: (host: SshConfigHost) => boolean;
  isProfileLive: (index: number) => boolean;
  onSelectConnection: (connection: Connection) => void;
  onSelectHost: (host: SshConfigHost) => void;
  onSelectProfile: (index: number) => void;
  onDisconnect: (connection: Connection) => void;
  onRemoveProfile: (index: number) => void;
  onReloadConfig: () => void;
  onCreate: () => void;
}

const PANEL_WIDTH = 380;
const endpoint = (username: string, host: string, port = 22) => `${username}@${host}${port === 22 ? '' : `:${port}`}`;

/** Places the fixed panel under its trigger, inside the app surface (which contains fixed children). */
function panelPosition(trigger: HTMLElement | null): CSSProperties {
  const surface = trigger?.closest('.app') as HTMLElement | null;
  if (!trigger || !surface) return {};
  const anchor = trigger.getBoundingClientRect();
  const frame = surface.getBoundingClientRect();
  const left = anchor.left - frame.left - surface.clientLeft;
  return { top: anchor.bottom - frame.top - surface.clientTop + 6, left: Math.max(8, Math.min(left, surface.clientWidth - PANEL_WIDTH - 8)) };
}

export default function DevicePicker(props: DevicePickerProps) {
  const { label, current, connections, configHosts, profiles } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => setOpen(false), []);
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (run: () => void) => () => { close(); run(); };
  const live = <span className="picker-tag">已连接</span>;

  const sections: Section[] = [
    {
      key: 'live', title: '已连接',
      items: connections.map(connection => ({
        key: `live:${connection.id}`, title: connection.name, kind: connection.kind,
        detail: connection.kind === 'ssh' ? endpoint(connection.username || '', connection.host || '') : '本地文件系统',
        current: connection.id === current?.id,
        state: connection.id === props.otherConnectionId && connection.id !== current?.id ? <span className="picker-tag is-plain">另一侧</span> : null,
        select: choose(() => props.onSelectConnection(connection)),
        action: connection.kind === 'ssh' ? { label: `断开 ${connection.name}`, icon: <Unplug size={13} />, run: () => props.onDisconnect(connection) } : undefined,
      })),
    },
    {
      key: 'config', title: 'SSH 配置',
      extra: <>
        <code title={props.configPath}>{props.configPath}</code>
        <button className="icon-btn icon-btn-sm" aria-label="重新读取配置" title="重新读取配置" disabled={props.configLoading} onClick={props.onReloadConfig}><RefreshCw size={11} className={props.configLoading ? 'spin' : ''} /></button>
      </>,
      notes: (props.configError || props.configWarnings.length > 0) && (
        <div className="picker-alert">
          <CircleAlert size={12} />
          <div>
            {props.configError ? <><strong>读取失败，可手动连接</strong><p>{props.configError}</p></> : props.configWarnings.map((warning, index) => <p key={index}>{warning}</p>)}
          </div>
        </div>
      ),
      items: configHosts.map(host => ({
        key: `ssh:${host.alias}`, title: host.alias, kind: 'ssh', detail: endpoint(host.username, host.host, host.port),
        current: false, warning: host.warning, state: host.warning ? null : props.isHostLive(host) ? live : null,
        select: choose(() => props.onSelectHost(host)),
      })),
    },
    {
      key: 'saved', title: '已保存的连接',
      items: profiles.map((profile, index) => ({
        key: `saved:${profile.host}:${profile.port}:${profile.username}`, title: profile.name || profile.host, kind: 'ssh',
        detail: endpoint(profile.username, profile.host, profile.port), current: false,
        state: props.isProfileLive(index) ? live : null,
        select: choose(() => props.onSelectProfile(index)),
        action: { label: `删除 ${profile.name || profile.host}`, icon: <Trash2 size={13} />, run: () => props.onRemoveProfile(index) },
      })),
    },
  ];
  const needle = query.trim().toLocaleLowerCase();
  const visible = sections
    .map(section => ({ ...section, items: section.items.filter(item => !needle || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(needle)) }))
    .filter(section => section.items.length > 0 || (section.key === 'config' && !needle));
  const flat = visible.flatMap(section => section.items);

  useDismiss(rootRef, open, dismiss);
  useEffect(() => {
    bodyRef.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);
  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [open, dismiss]);

  const toggle = () => {
    if (open) { close(); return; }
    setQuery('');
    setActive(Math.max(0, sections[0].items.findIndex(item => item.current)));
    setPosition(panelPosition(triggerRef.current));
    setOpen(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (!flat.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      flat[Math.min(active, flat.length - 1)]?.select();
    }
  };

  let index = -1;
  return (
    <div className="picker" ref={rootRef}>
      {props.trigger({ open, toggle, ref: triggerRef })}
      {open && (
        <div className="picker-panel" role="dialog" aria-label={`选择${label}`} style={position} onKeyDown={onKeyDown}>
          <label className="picker-search">
            <Search size={13} />
            <input autoFocus placeholder="搜索名称、主机或用户" aria-label="搜索设备" value={query} spellCheck={false} onChange={event => { setQuery(event.target.value); setActive(0); }} />
          </label>
          <div className="picker-body" ref={bodyRef}>
            {visible.map(section => (
              <div className="picker-section" role="group" aria-label={section.title} key={section.key}>
                <div className="picker-section-head"><span>{section.title}</span>{section.extra}</div>
                {section.notes}
                {section.items.length === 0 && !props.configError && <div className="picker-note">{props.configLoading ? '读取中…' : '配置中没有可用的主机'}</div>}
                {section.items.map(item => {
                  index += 1;
                  const position = index;
                  return (
                    <div className={`picker-row ${position === active ? 'is-active' : ''}`} key={item.key} onMouseMove={() => setActive(position)}>
                      <button className="picker-option" aria-current={item.current || undefined} title={item.warning || undefined} onClick={item.select}>
                        {item.kind === 'ssh' ? <Server size={14} className="picker-kind" /> : <Laptop size={14} className="picker-kind" />}
                        <span className="picker-text">
                          <span className="picker-title">{item.title}</span>
                          <span className={`picker-detail ${item.warning ? 'is-warning' : ''}`}>{item.warning ? `需检查配置 · ${item.warning}` : item.detail}</span>
                        </span>
                        <span className="picker-state">{item.current ? <Check size={14} /> : item.state}</span>
                      </button>
                      {item.action && <button className="icon-btn picker-action" aria-label={item.action.label} title={item.action.label} onClick={item.action.run}>{item.action.icon}</button>}
                    </div>
                  );
                })}
              </div>
            ))}
            {needle && flat.length === 0 && <div className="picker-note picker-empty">没有匹配的设备</div>}
          </div>
          <div className="picker-foot">
            <button className="picker-create" onClick={choose(props.onCreate)}><Plus size={13} />新建连接…</button>
          </div>
        </div>
      )}
    </div>
  );
}
