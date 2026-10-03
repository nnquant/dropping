import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, CircleAlert, CornerDownLeft, Eye,
  LoaderCircle, Plus, RefreshCw, Search, X,
} from 'lucide-react';
import { api, appWindow, isDesktop, onTransferProgress } from './bridge';
import DevicePicker from './DevicePicker';
import { FileIcon, formatDate, formatSize } from './files';
import TransferQueue, { type QueueItem } from './TransferQueue';
import type { Connection, DirectoryListing, FileEntry, HostKey, Preview, SshConfig, SshConfigHost, SshConfigHosts } from './types';
import './App.css';

type Side = 0 | 1;
type SortKey = 'name' | 'size' | 'modified';
type PaneState = {
  connectionId: string; path: string; draftPath: string; listing: DirectoryListing | null;
  loading: boolean; error: string | null; selected: string | null; search: string;
  sort: SortKey; ascending: boolean; history: string[];
};
type Profile = Pick<SshConfig, 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'privateKeyPath'>;
type ConnectForm = Profile & { password: string; passphrase: string };
type PreviewState = { file: FileEntry; connectionName: string; loading: boolean; data: Preview | null; error: string | null };
const emptyPane = (): PaneState => ({ connectionId: '', path: '', draftPath: '', listing: null, loading: true, error: null, selected: null, search: '', sort: 'name', ascending: true, history: [] });
const newForm = (): ConnectForm => ({ name: '', host: '', port: 22, username: '', authMethod: 'key', privateKeyPath: '', password: '', passphrase: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const PROFILE_KEY = 'dropping.connections.v1';
const profileKey = (profile: Pick<Profile, 'host' | 'port' | 'username'>) => `${profile.username}@${profile.host}:${profile.port}`;
const importedHostKey = (host: SshConfigHost) => JSON.stringify([host.alias, host.host, host.port, host.username, host.authMethod, host.privateKeyPath, host.warning]);

function visibleEntries(pane: PaneState, showHidden: boolean) {
  return (pane.listing?.entries || [])
    .filter(entry => (showHidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(pane.search.toLocaleLowerCase()))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const comparison = pane.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : (a[pane.sort] || 0) - (b[pane.sort] || 0);
      return pane.ascending ? comparison : -comparison;
    });
}
function readProfiles(): Profile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROFILE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Profile => item && typeof item.host === 'string' && typeof item.username === 'string' && Number.isInteger(item.port) && item.port >= 1 && item.port <= 65535 && ['key', 'password'].includes(item.authMethod))
      .map(item => ({ name: typeof item.name === 'string' ? item.name : item.host, host: item.host, port: item.port, username: item.username, authMethod: item.authMethod, privateKeyPath: typeof item.privateKeyPath === 'string' ? item.privateKeyPath : '' }));
  } catch { return []; }
}

export default function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [panes, setPanes] = useState<[PaneState, PaneState]>([emptyPane(), emptyPane()]);
  const panesRef = useRef(panes);
  const connectionsRef = useRef(connections);
  const localRef = useRef<Connection | null>(null);
  const requests = useRef([0, 0]);
  const [activeSide, setActiveSide] = useState<Side>(0);
  const [showHidden, setShowHidden] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const pending = useRef<QueueItem[]>([]);
  const running = useRef<string | null>(null);
  const cancelled = useRef(new Set<string>());
  const [notification, setNotification] = useState<{ text: string; error: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectSide, setConnectSide] = useState<Side>(1);
  const [profiles, setProfiles] = useState<Profile[]>(readProfiles);
  const [sshConfig, setSshConfig] = useState<SshConfigHosts>({ path: '~/.ssh/config', hosts: [], warnings: [] });
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const configRequest = useRef(0);
  const importedConnections = useRef(new Map<string, string>());
  const savedConnections = useRef(new Map<string, string>());
  const [importedProfile, setImportedProfile] = useState<SshConfigHost | null>(null);
  const [formSource, setFormSource] = useState('manual');
  const [form, setForm] = useState<ConnectForm>(newForm);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<HostKey | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const previewRequest = useRef(0);

  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => {
    const next: [PaneState, PaneState] = [...panesRef.current];
    next[side] = updater(next[side]);
    panesRef.current = next;
    setPanes(next);
  }, []);
  const notify = useCallback((text: string, error = false) => {
    setNotification({ text, error });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotification(null), error ? 9000 : 4500);
  }, []);
  const loadDirectory = useCallback(async (side: Side, connectionId: string, path: string, addHistory = true) => {
    const token = ++requests.current[side];
    const previous = panesRef.current[side];
    updatePane(side, current => ({ ...current, connectionId, loading: true, error: null, selected: null,
      ...(connectionId !== current.connectionId ? { listing: null, history: [], path, draftPath: path, search: '' } : {}),
    }));
    try {
      const listing = await api.listDirectory(connectionId, path);
      if (requests.current[side] !== token) return;
      updatePane(side, current => ({ ...current, loading: false, listing, path: listing.path, draftPath: listing.path, error: null,
        history: addHistory && previous.connectionId === connectionId && previous.path && previous.path !== listing.path ? [...previous.history, previous.path] : current.history,
      }));
    } catch (error) {
      if (requests.current[side] !== token) return;
      updatePane(side, current => ({ ...current, loading: false, error: messageOf(error), draftPath: path }));
    }
  }, [updatePane]);

  const reloadSshConfig = useCallback(async () => {
    const token = ++configRequest.current;
    setConfigLoading(true);
    setConfigError(null);
    try {
      const result = await api.getSshConfigHosts();
      if (token === configRequest.current) setSshConfig(result);
    } catch (error) {
      if (token === configRequest.current) {
        setConfigError(messageOf(error));
        setSshConfig(current => ({ ...current, hosts: [], warnings: [] }));
      }
    } finally {
      if (token === configRequest.current) setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadSshConfig();
    return () => { ++configRequest.current; };
  }, [reloadSshConfig]);

  useEffect(() => {
    let disposed = false;
    api.getLocalInfo().then(local => {
      if (disposed) return;
      localRef.current = local;
      connectionsRef.current = [local];
      setConnections([local]);
      void loadDirectory(0, local.id, local.home, false);
      void loadDirectory(1, local.id, local.home, false);
    }).catch(error => {
      if (disposed) return;
      ([0, 1] as Side[]).forEach(side => updatePane(side, pane => ({ ...pane, loading: false, error: messageOf(error) })));
    });
    return () => { disposed = true; clearTimeout(noticeTimer.current); };
  }, [loadDirectory, updatePane]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onTransferProgress(progress => {
      setQueue(current => current.map(item => item.id === progress.id ? { ...item, ...progress } : item));
    }).then(cleanup => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(error => notify(`无法订阅传输进度：${messageOf(error)}`, true));
    return () => { disposed = true; unlisten?.(); };
  }, [notify]);

  const refreshDestination = useCallback((item: QueueItem) => {
    ([0, 1] as Side[]).forEach(side => {
      const pane = panesRef.current[side];
      if (pane.connectionId === item.destinationConnectionId && pane.path === item.destinationDirectory) void loadDirectory(side, pane.connectionId, pane.path, false);
    });
  }, [loadDirectory]);
  const runQueue = useCallback(async () => {
    if (running.current) return;
    while (pending.current.length > 0) {
      const item = pending.current.shift()!;
      if (cancelled.current.has(item.id)) continue;
      running.current = item.id;
      setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, status: 'running' } : entry));
      try {
        const result = await api.startTransfer({ id: item.id, sourceConnectionId: item.sourceConnectionId, destinationConnectionId: item.destinationConnectionId, sourcePath: item.sourcePath, destinationDirectory: item.destinationDirectory });
        setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, status: 'completed', bytesTransferred: result.bytes, totalBytes: result.bytes, filesTransferred: result.files, totalFiles: result.files } : entry));
        refreshDestination(item);
      } catch (error) {
        const errorMessage = messageOf(error);
        const wasCancelled = cancelled.current.has(item.id) || /cancelled|canceled|已取消/i.test(errorMessage);
        const simpleCancellation = /^(?:Error: )?(?:传输已取消|(?:transfer )?cancelled|(?:transfer )?canceled)$/i.test(errorMessage.trim());
        const visibleError = wasCancelled && simpleCancellation ? undefined : errorMessage;
        setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, status: wasCancelled ? 'cancelled' : 'failed', error: visibleError } : entry));
        if (visibleError) notify(`${item.name} ${wasCancelled ? '取消后需检查' : '传输失败'}：${visibleError}`, true);
        refreshDestination(item);
      } finally {
        cancelled.current.delete(item.id);
        running.current = null;
      }
    }
  }, [notify, refreshDestination]);

  const enqueue = useCallback((side: Side, entry?: FileEntry) => {
    const source = panesRef.current[side];
    const destination = panesRef.current[side === 0 ? 1 : 0];
    const file = entry || source.listing?.entries.find(candidate => candidate.path === source.selected);
    if (!file || source.loading || destination.loading) return;
    if (!source.listing || !destination.listing || source.error || destination.error) { notify('请先在两侧打开可访问的目录。', true); return; }
    if (source.connectionId === destination.connectionId && source.path === destination.path) { notify('两侧是同一个目录，请先选择另一个目标目录。', true); return; }
    const sourceConnection = connectionsRef.current.find(connection => connection.id === source.connectionId);
    const destinationConnection = connectionsRef.current.find(connection => connection.id === destination.connectionId);
    if (!sourceConnection || !destinationConnection) return;
    const item: QueueItem = {
      id: crypto.randomUUID(), name: file.name, isDir: file.isDir, sourceName: sourceConnection.name,
      destinationName: destinationConnection.name, sourceConnectionId: source.connectionId,
      destinationConnectionId: destination.connectionId, sourcePath: file.path, destinationDirectory: destination.path,
      status: 'queued', bytesTransferred: 0, totalBytes: file.isDir ? 0 : file.size, filesTransferred: 0, totalFiles: file.isDir ? 0 : 1, currentFile: file.name,
    };
    pending.current.push(item);
    setQueue(current => [...current, item]);
    void runQueue();
  }, [notify, runQueue]);

  const openPreview = useCallback(async (side: Side, file?: FileEntry) => {
    const pane = panesRef.current[side];
    const entry = file || pane.listing?.entries.find(item => item.path === pane.selected);
    if (!entry || entry.isDir || pane.loading || pane.error) return;
    const request = ++previewRequest.current;
    setPreview({ file: entry, connectionName: connectionsRef.current.find(connection => connection.id === pane.connectionId)?.name || '', loading: true, data: null, error: null });
    try {
      const data = await api.previewFile(pane.connectionId, entry.path);
      if (request === previewRequest.current) setPreview(current => current ? { ...current, loading: false, data } : null);
    } catch (error) {
      if (request === previewRequest.current) setPreview(current => current ? { ...current, loading: false, error: messageOf(error) } : null);
    }
  }, []);
  const closePreview = useCallback(() => { ++previewRequest.current; setPreview(null); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (preview) closePreview();
        else if (connectOpen && !connectionBusy) setConnectOpen(false);
        return;
      }
      if (connectOpen || preview || event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName))) return;
      const pane = panesRef.current[activeSide];
      if (event.code === 'Space') { event.preventDefault(); void openPreview(activeSide); }
      if (event.key === 'Enter') {
        const entry = pane.listing?.entries.find(file => file.path === pane.selected);
        if (!entry || pane.loading || pane.error) return;
        event.preventDefault();
        if (entry.isDir) void loadDirectory(activeSide, pane.connectionId, entry.path);
        else enqueue(activeSide, entry);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const entries = visibleEntries(pane, showHidden);
        const current = entries.findIndex(file => file.path === pane.selected);
        const next = event.key === 'ArrowDown' ? Math.min(current + 1, entries.length - 1) : Math.max(current - 1, 0);
        if (entries[next]) updatePane(activeSide, state => ({ ...state, selected: entries[next].path }));
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (pane.connectionId) void loadDirectory(activeSide, pane.connectionId, pane.path, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSide, closePreview, connectOpen, connectionBusy, enqueue, loadDirectory, openPreview, preview, showHidden, updatePane]);

  const openConnect = (side: Side = 1) => { setConnectSide(side); setForm(newForm()); setImportedProfile(null); setFormSource('manual'); setConnectionError(null); setHostKey(null); setConnectOpen(true); };
  const chooseImportedHost = (side: Side, host: SshConfigHost) => {
    const existingId = importedConnections.current.get(importedHostKey(host));
    const existing = connectionsRef.current.find(connection => connection.id === existingId);
    if (existing && !host.warning) {
      setConnectOpen(false);
      void loadDirectory(side, existing.id, existing.home, false);
      return;
    }
    setConnectSide(side);
    setImportedProfile(host);
    setFormSource(`ssh:${host.alias}`);
    setForm({ name: host.alias, host: host.host, port: host.port, username: host.username, authMethod: host.authMethod, privateKeyPath: host.privateKeyPath || '', password: '', passphrase: '' });
    setConnectionError(null);
    setHostKey(null);
    setConnectOpen(true);
  };
  const liveConnection = (id: string | undefined) => connectionsRef.current.find(connection => connection.id === id);
  const chooseProfile = (side: Side, index: number) => {
    const profile = profiles[index];
    if (!profile) return;
    const existing = liveConnection(savedConnections.current.get(profileKey(profile)));
    if (existing) { void loadDirectory(side, existing.id, existing.home, false); return; }
    setConnectSide(side);
    setImportedProfile(null);
    setFormSource(`saved:${index}`);
    setForm({ ...profile, password: '', passphrase: '' });
    setConnectionError(null);
    setHostKey(null);
    setConnectOpen(true);
  };
  const removeProfile = (index: number) => {
    const saved = profiles.filter((_, position) => position !== index);
    setProfiles(saved);
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(saved)); } catch { /* Removal still applies for this session. */ }
  };
  const probeConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (importedProfile?.warning || connectionBusy) return;
    setConnectionError(null);
    setConnectionBusy(true);
    try { setHostKey(await api.probeSsh(form.host.trim(), Number(form.port))); }
    catch (error) { setConnectionError(messageOf(error)); }
    finally { setConnectionBusy(false); }
  };
  const confirmConnection = async () => {
    if (!hostKey || importedProfile?.warning || connectionBusy) return;
    setConnectionBusy(true);
    setConnectionError(null);
    try {
      const config: SshConfig = { ...form, name: form.name.trim() || form.host.trim(), host: form.host.trim(), username: form.username.trim(), port: Number(form.port), fingerprint: hostKey.fingerprint };
      const connection = await api.connectSsh(config);
      connectionsRef.current = [...connectionsRef.current.filter(item => item.id !== connection.id), connection];
      setConnections(connectionsRef.current);
      if (importedProfile) {
        importedConnections.current.set(importedHostKey(importedProfile), connection.id);
      } else {
        const profile: Profile = { name: config.name, host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, privateKeyPath: config.privateKeyPath };
        const saved = [...profiles.filter(item => !(item.host === profile.host && item.port === profile.port && item.username === profile.username)), profile];
        setProfiles(saved);
        savedConnections.current.set(profileKey(profile), connection.id);
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(saved)); } catch { /* Connections work even when storage is unavailable. */ }
      }
      setConnectOpen(false);
      setForm(newForm());
      setImportedProfile(null);
      setFormSource('manual');
      setHostKey(null);
      void loadDirectory(connectSide, connection.id, connection.home, false);
      notify(`已连接 ${connection.name}`);
    } catch (error) { setConnectionError(messageOf(error)); }
    finally { setConnectionBusy(false); }
  };
  const disconnect = async (connection: Connection) => {
    if (queue.some(item => ['queued', 'running'].includes(item.status) && [item.sourceConnectionId, item.destinationConnectionId].includes(connection.id))) { notify('这个连接仍有传输任务，请先等待完成或取消任务。', true); return; }
    try {
      await api.disconnect(connection.id);
      connectionsRef.current = connectionsRef.current.filter(item => item.id !== connection.id);
      setConnections(connectionsRef.current);
      const local = localRef.current;
      if (local) ([0, 1] as Side[]).forEach(side => { if (panesRef.current[side].connectionId === connection.id) void loadDirectory(side, local.id, local.home, false); });
      notify(`已断开 ${connection.name}`);
    } catch (error) { notify(messageOf(error), true); }
  };
  const cancel = async (item: QueueItem) => {
    cancelled.current.add(item.id);
    if (item.status === 'queued') {
      pending.current = pending.current.filter(entry => entry.id !== item.id);
      setQueue(current => current.map(entry => entry.id === item.id ? { ...entry, status: 'cancelled' } : entry));
      cancelled.current.delete(item.id);
      return;
    }
    try { await api.cancelTransfer(item.id); }
    catch (error) { cancelled.current.delete(item.id); notify(`取消失败：${messageOf(error)}`, true); }
  };

  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => { void appWindow.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    sync();
    appWindow.onResized(sync).then(cleanup => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const remoteCount = connections.filter(connection => connection.kind === 'ssh').length;
  const refreshAll = () => {
    void reloadSshConfig();
    ([0, 1] as Side[]).forEach(side => {
      const pane = panesRef.current[side];
      if (pane.connectionId) void loadDirectory(side, pane.connectionId, pane.path, false);
    });
  };

  return (
    <div className="app">
      <header className="titlebar" data-tauri-drag-region>
        <div className="wordmark" aria-label="Dropping 文件传输" data-tauri-drag-region><span className="wordmark-glyph" data-tauri-drag-region />Dropping</div>
        <div className="titlebar-actions" data-tauri-drag-region>
          <button className={`tool ${showHidden ? 'is-on' : ''}`} onClick={() => setShowHidden(value => !value)} aria-pressed={showHidden}>
            <span className="tool-check" aria-hidden="true">{showHidden && <Check size={10} strokeWidth={3} />}</span>隐藏文件
          </button>
          <button className="tool" onClick={refreshAll} title="刷新目录与 SSH 配置" disabled={!connections.length}><RefreshCw size={14} />刷新</button>
          <TransferQueue
            items={queue}
            onCancel={item => void cancel(item)}
            onClearFinished={() => setQueue(current => current.filter(item => ['queued', 'running'].includes(item.status)))}
          />
          <button className="btn btn-primary" onClick={() => openConnect()}><Plus size={14} />新建连接</button>
        </div>
        {isDesktop && (
          <div className="window-controls">
            <button aria-label="最小化" title="最小化" onClick={() => void appWindow.minimize()}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
            </button>
            <button aria-label={maximized ? '向下还原' : '最大化'} title={maximized ? '向下还原' : '最大化'} onClick={() => void appWindow.toggleMaximize()}>
              {maximized
                ? <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" /></svg>
                : <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" /></svg>}
            </button>
            <button className="window-close" aria-label="关闭" title="关闭" onClick={() => void appWindow.close()}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9m0-9l-9 9" stroke="currentColor" /></svg>
            </button>
          </div>
        )}
      </header>

      {!isDesktop && <div className="banner"><CircleAlert size={13} />当前为浏览器预览。请运行 Dropping 桌面客户端，使用本机文件与 SSH 连接。</div>}

      <main className="workspace">
        {([0, 1] as Side[]).map(side => {
          const pane = panes[side];
          const other = panes[side === 0 ? 1 : 0];
          const connection = connections.find(item => item.id === pane.connectionId);
          const entries = visibleEntries(pane, showHidden);
          const selected = pane.listing?.entries.find(item => item.path === pane.selected);
          const sideName = side === 0 ? '左侧' : '右侧';
          return (
            <section className={`pane ${activeSide === side ? 'active-pane' : ''}`} key={side} onPointerDown={() => setActiveSide(side)} onFocusCapture={() => setActiveSide(side)} aria-label={`${sideName}工作区`}>
              <div className="pane-head">
                <DevicePicker
                  label={`${sideName}设备`}
                  current={connection}
                  otherConnectionId={other.connectionId}
                  connections={connections}
                  configHosts={sshConfig.hosts}
                  configPath={sshConfig.path}
                  configLoading={configLoading}
                  profiles={profiles}
                  isHostLive={host => !!liveConnection(importedConnections.current.get(importedHostKey(host)))}
                  isProfileLive={index => !!liveConnection(savedConnections.current.get(profileKey(profiles[index])))}
                  onSelectConnection={next => void loadDirectory(side, next.id, next.home, false)}
                  onSelectHost={host => chooseImportedHost(side, host)}
                  onSelectProfile={index => chooseProfile(side, index)}
                  onDisconnect={target => void disconnect(target)}
                  onRemoveProfile={removeProfile}
                  onReloadConfig={() => void reloadSshConfig()}
                  onCreate={() => openConnect(side)}
                />
                <span className="pane-address">{connection?.kind === 'ssh' ? `${connection.username}@${connection.host}` : connection ? '本地文件系统' : '未就绪'}</span>
              </div>

              <div className="pane-nav">
                <button className="icon-btn" title="返回上一个目录" aria-label="返回上一个目录" disabled={!pane.history.length || pane.loading} onClick={() => {
                  const path = pane.history[pane.history.length - 1];
                  updatePane(side, current => ({ ...current, history: current.history.slice(0, -1) }));
                  void loadDirectory(side, pane.connectionId, path, false);
                }}><ArrowLeft size={14} /></button>
                <button className="icon-btn" title="上一级目录" aria-label="上一级目录" disabled={!pane.listing?.parent || pane.loading} onClick={() => { if (pane.listing?.parent) void loadDirectory(side, pane.connectionId, pane.listing.parent); }}><ArrowUp size={14} /></button>
                <form className="path-field" onSubmit={event => { event.preventDefault(); if (pane.draftPath.trim() && pane.connectionId) void loadDirectory(side, pane.connectionId, pane.draftPath.trim()); }}>
                  <input aria-label={`${sideName}目录路径`} value={pane.draftPath} placeholder="输入目录路径" spellCheck={false} onChange={event => updatePane(side, current => ({ ...current, draftPath: event.target.value }))} disabled={!connection} />
                  <button type="submit" className="path-go" aria-label="打开目录" title="打开目录" disabled={!connection}><CornerDownLeft size={12} /></button>
                </form>
                <button className="icon-btn" title="刷新目录" aria-label="刷新目录" disabled={!pane.connectionId || pane.loading} onClick={() => void loadDirectory(side, pane.connectionId, pane.path, false)}><RefreshCw size={13} className={pane.loading ? 'spin' : ''} /></button>
                <label className="filter-field">
                  <Search size={12} />
                  <input placeholder="筛选" aria-label={`筛选${sideName}文件`} value={pane.search} onChange={event => updatePane(side, current => ({ ...current, search: event.target.value, selected: null }))} />
                  {pane.search && <button className="filter-clear" aria-label="清除筛选" onClick={() => updatePane(side, current => ({ ...current, search: '' }))}><X size={11} /></button>}
                </label>
              </div>

              <div className={`file-list ${pane.loading ? 'is-loading' : ''}`} tabIndex={0} aria-label={`${sideName}文件列表，空格预览，回车打开或传输`}>
                {pane.loading && <div className="load-bar" />}
                <table className="file-table">
                  <thead>
                    <tr>
                      {([{ key: 'name', label: '名称' }, { key: 'size', label: '大小' }, { key: 'modified', label: '修改时间' }] as { key: SortKey; label: string }[]).map(column => (
                        <th key={column.key} className={`col-${column.key}`} aria-sort={pane.sort === column.key ? pane.ascending ? 'ascending' : 'descending' : 'none'}>
                          <button onClick={() => updatePane(side, current => ({ ...current, sort: column.key, ascending: current.sort === column.key ? !current.ascending : true }))}>
                            {column.label}{pane.sort === column.key && <ChevronDown size={11} className={pane.ascending ? 'sort-asc' : ''} />}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {!pane.error && entries.map(entry => (
                      <tr key={entry.path} className={pane.selected === entry.path ? 'selected-row' : ''} aria-selected={pane.selected === entry.path}
                        onClick={() => updatePane(side, current => ({ ...current, selected: entry.path }))}
                        onDoubleClick={() => { if (pane.loading) return; if (entry.isDir) void loadDirectory(side, pane.connectionId, entry.path); else enqueue(side, entry); }}>
                        <td><span className="file-name" title={entry.name}><FileIcon entry={entry} /><span>{entry.name}</span>{entry.isSymlink && <span className="symlink" title="符号链接">↗</span>}</span></td>
                        <td className="col-size">{entry.isDir ? '' : formatSize(entry.size)}</td>
                        <td className="col-modified">{formatDate(entry.modified)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {pane.loading && !pane.listing && <div className="list-state"><span className="muted">读取中…</span></div>}
                {!pane.loading && pane.error && (
                  <div className="list-state">
                    <strong>{isDesktop ? '无法打开目录' : '需要桌面客户端'}</strong>
                    <p>{isDesktop ? pane.error : '在桌面客户端中浏览本机目录，或通过 SFTP 连接远程设备。'}</p>
                    {pane.connectionId && <button className="btn" onClick={() => void loadDirectory(side, pane.connectionId, pane.draftPath || pane.path, false)}>重试</button>}
                  </div>
                )}
                {!pane.loading && !pane.error && entries.length === 0 && (
                  <div className="list-state">
                    <strong>{pane.search ? '没有匹配的文件' : '空目录'}</strong>
                    <p>{pane.search ? '换个关键词，或清除筛选。' : '双击另一侧的文件，即可传到这里。'}</p>
                  </div>
                )}
              </div>

              <div className="pane-foot">
                <span className="pane-foot-info">
                  {selected ? <><span className="truncate">{selected.name}</span>{!selected.isDir && <span className="muted">{formatSize(selected.size)}</span>}</> : <span className="muted">{pane.listing && !pane.error ? `${entries.length} 项` : ''}</span>}
                </span>
                <button className="btn btn-ghost" disabled={!selected || selected.isDir || pane.loading || !!pane.error} onClick={() => void openPreview(side)}><Eye size={13} />预览</button>
                <button className="btn" disabled={!selected || pane.loading || !!pane.error || other.loading || !other.listing || !!other.error} onClick={() => enqueue(side)}>
                  {side === 1 && <ArrowLeft size={13} />}传到{side === 0 ? '右侧' : '左侧'}{side === 0 && <ArrowRight size={13} />}
                </button>
              </div>
            </section>
          );
        })}
      </main>

      <footer className="statusbar">
        <span className="status-item"><span className={`dot ${isDesktop ? '' : 'off'}`} />{isDesktop ? '就绪' : '浏览器预览'}</span>
        <span className="status-item">{remoteCount} 个远程连接</span>
        <span className="status-item ssh-status">
          <span>SSH 配置</span>
          <code title={sshConfig.path}>{sshConfig.path}</code>
          <span>{configLoading ? '读取中…' : `${sshConfig.hosts.length} 台设备`}</span>
          <button className="icon-btn icon-btn-sm" aria-label="重新读取 SSH 配置" title="重新读取 SSH 配置" disabled={configLoading} onClick={() => void reloadSshConfig()}><RefreshCw size={11} className={configLoading ? 'spin' : ''} /></button>
          {(configError || sshConfig.warnings.length > 0) && (
            <details className="config-warnings">
              <summary>{configError ? '读取失败，可手动连接' : `${sshConfig.warnings.length} 项提示`}</summary>
              <div className="popover">{configError ? <p>{configError}</p> : sshConfig.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
            </details>
          )}
        </span>
        <span className="status-item status-version muted">v0.1.1</span>
      </footer>

      {notification && (
        <div className={`toast ${notification.error ? 'toast-error' : ''}`} role={notification.error ? 'alert' : 'status'}>
          {notification.error ? <CircleAlert size={14} /> : <Check size={14} />}
          <span>{notification.text}</span>
          <button className="icon-btn" onClick={() => setNotification(null)} aria-label="关闭提示"><X size={13} /></button>
        </div>
      )}

      {connectOpen && (
        <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !connectionBusy) setConnectOpen(false); }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
            <div className="dialog-head">
              <div>
                <h2 id="connection-title">{hostKey ? '确认服务器身份' : '连接远程设备'}</h2>
                <p>{hostKey ? '建立连接前，请核对 SSH 主机指纹。' : '通过 SFTP 访问另一台电脑的文件。'}</p>
              </div>
              <button className="icon-btn" onClick={() => setConnectOpen(false)} disabled={connectionBusy} aria-label="关闭连接窗口"><X size={15} /></button>
            </div>
            {!hostKey ? (
              <form onSubmit={event => void probeConnection(event)} className="dialog-body">
                <fieldset disabled={connectionBusy}>
                  <label className="field"><span>连接来源</span><select value={formSource} onChange={event => {
                    const value = event.target.value;
                    if (value.startsWith('ssh:')) {
                      const host = sshConfig.hosts.find(item => item.alias === value.slice(4));
                      if (host) chooseImportedHost(connectSide, host);
                      return;
                    }
                    setFormSource(value);
                    setImportedProfile(null);
                    setConnectionError(null);
                    const profile = value.startsWith('saved:') ? profiles[Number(value.slice(6))] : null;
                    setForm(profile ? { ...profile, password: '', passphrase: '' } : newForm());
                  }}>
                    <option value="manual">手动填写连接信息</option>
                    {sshConfig.hosts.length > 0 && <optgroup label="SSH 配置">{sshConfig.hosts.map(host => <option key={host.alias} value={`ssh:${host.alias}`}>{host.alias} · {host.username}@{host.host}{host.warning ? ' · 需检查配置' : ''}</option>)}</optgroup>}
                    {profiles.length > 0 && <optgroup label="已保存的连接">{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.username}`} value={`saved:${index}`}>{profile.name || profile.host} · {profile.username}@{profile.host}</option>)}</optgroup>}
                  </select></label>
                  {importedProfile && <p className="hint" title={sshConfig.path}>参数来自 {sshConfig.path}，如需修改请切换为手动填写。</p>}
                  {importedProfile?.warning && <div className="form-error" role="alert"><CircleAlert size={13} /><span>此配置暂不能直接连接：{importedProfile.warning}</span></div>}
                  <label className="field"><span>连接名称 <em>可选</em></span><input placeholder="例如：研究服务器" autoFocus readOnly={!!importedProfile} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
                  <div className="field-row">
                    <label className="field"><span>主机地址</span><input required readOnly={!!importedProfile} placeholder="192.168.1.100 或 example.com" value={form.host} onChange={event => setForm(current => ({ ...current, host: event.target.value }))} spellCheck={false} /></label>
                    <label className="field field-port"><span>端口</span><input type="number" min="1" max="65535" required readOnly={!!importedProfile} value={form.port} onChange={event => setForm(current => ({ ...current, port: Number(event.target.value) }))} /></label>
                  </div>
                  <label className="field"><span>用户名</span><input required readOnly={!!importedProfile} autoComplete="username" value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} spellCheck={false} /></label>
                  <div className="field">
                    <span>认证方式</span>
                    <div className="segmented" role="group" aria-label="认证方式">
                      <button type="button" disabled={!!importedProfile} className={form.authMethod === 'key' ? 'is-selected' : ''} onClick={() => setForm(current => ({ ...current, authMethod: 'key' }))}>SSH 私钥</button>
                      <button type="button" disabled={!!importedProfile} className={form.authMethod === 'password' ? 'is-selected' : ''} onClick={() => setForm(current => ({ ...current, authMethod: 'password' }))}>密码</button>
                    </div>
                  </div>
                  {form.authMethod === 'key' ? <>
                    <label className="field"><span>本机私钥路径</span><input required readOnly={!!importedProfile} placeholder="C:\Users\you\.ssh\id_ed25519" value={form.privateKeyPath || ''} onChange={event => setForm(current => ({ ...current, privateKeyPath: event.target.value }))} spellCheck={false} /></label>
                    <label className="field"><span>私钥口令 <em>可选</em></span><input type="password" autoComplete="off" placeholder="私钥已加密时填写" value={form.passphrase} onChange={event => setForm(current => ({ ...current, passphrase: event.target.value }))} /></label>
                  </> : <label className="field"><span>密码</span><input type="password" required autoComplete="current-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label>}
                  {connectionError && <div className="form-error" role="alert"><CircleAlert size={13} /><span>{connectionError}</span></div>}
                  <div className="dialog-foot">
                    <span className="hint">密码和口令仅用于本次连接，不会保存。</span>
                    <button type="button" className="btn" onClick={() => setConnectOpen(false)} disabled={connectionBusy}>取消</button>
                    <button className="btn btn-primary" type="submit" disabled={connectionBusy || !!importedProfile?.warning}>{connectionBusy && <LoaderCircle size={13} className="spin" />}{connectionBusy ? '正在检查服务器…' : '继续连接'}</button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <div className="dialog-body">
                <dl className="fingerprint">
                  <dt>服务器</dt><dd><code>{form.host}:{form.port}</code></dd>
                  <dt>{hostKey.keyType}</dt><dd><code>{hostKey.fingerprint}</code></dd>
                </dl>
                <p className="hint">请与服务器管理员提供的指纹核对，一致时再信任此连接。可在服务器上运行 <code>ssh-keygen -lf</code> 查看主机公钥指纹。</p>
                {connectionError && <div className="form-error" role="alert"><CircleAlert size={13} /><span>{connectionError}</span></div>}
                <div className="dialog-foot">
                  <button className="btn" onClick={() => { setHostKey(null); setConnectionError(null); }} disabled={connectionBusy}>返回修改</button>
                  <button className="btn btn-primary" onClick={() => void confirmConnection()} disabled={connectionBusy}>{connectionBusy && <LoaderCircle size={13} className="spin" />}{connectionBusy ? '正在连接…' : '信任并连接'}</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {preview && (
        <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closePreview(); }}>
          <section className="dialog preview" role="dialog" aria-modal="true" aria-labelledby="preview-title">
            <div className="dialog-head">
              <div>
                <h2 id="preview-title">{preview.file.name}</h2>
                <p>{preview.connectionName} · {formatSize(preview.file.size)}</p>
              </div>
              <button className="icon-btn" aria-label="关闭预览" onClick={closePreview}><X size={15} /></button>
            </div>
            <div className={`preview-content ${preview.data?.kind === 'image' ? 'is-image' : ''}`}>
              {preview.loading ? <div className="list-state"><span className="muted">加载中…</span></div>
                : preview.error ? <div className="list-state"><strong>无法预览此文件</strong><p>{preview.error}</p></div>
                : preview.data?.kind === 'text' ? <pre><code>{preview.data.content}</code></pre>
                : preview.data?.kind === 'image' ? <img src={preview.data.content.startsWith('data:') ? preview.data.content : `data:${preview.data.mime};base64,${preview.data.content}`} alt={preview.file.name} />
                : <div className="list-state"><strong>不支持预览此类型</strong><p>{preview.data?.content || '支持常见文本、代码文件和图片。文件仍可正常传输。'}</p></div>}
            </div>
            <div className="preview-foot">
              <code title={preview.file.path}>{preview.file.path}</code>
              {preview.data?.kind === 'text' && preview.data.truncated && <span>文件较大，仅显示开头部分</span>}
              <span>只读</span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
