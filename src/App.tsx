import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUp, Check,
  CheckCircle2, ChevronDown, ChevronRight, CircleAlert, Copy, Eye, EyeOff,
  File, FileArchive, FileCode2, FileImage, FileText, Folder, HardDrive, KeyRound,
  Laptop, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, Server, ShieldCheck,
  Unplug, X,
} from 'lucide-react';
import { api, isDesktop, onTransferProgress } from './bridge';
import type { Connection, DirectoryListing, FileEntry, HostKey, Preview, SshConfig, SshConfigHost, SshConfigHosts, TransferProgress } from './types';
import './App.css';

type Side = 0 | 1;
type SortKey = 'name' | 'size' | 'modified';
type PaneState = {
  connectionId: string; path: string; draftPath: string; listing: DirectoryListing | null;
  loading: boolean; error: string | null; selected: string | null; search: string;
  sort: SortKey; ascending: boolean; history: string[];
};
type QueueItem = {
  id: string; name: string; isDir: boolean; sourceName: string; destinationName: string;
  sourceConnectionId: string; destinationConnectionId: string; sourcePath: string;
  destinationDirectory: string; status: 'queued' | TransferProgress['status'];
  bytesTransferred: number; totalBytes: number; filesTransferred: number; totalFiles: number;
  error?: string; currentFile: string;
};
type Profile = Pick<SshConfig, 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'privateKeyPath'>;
type ConnectForm = Profile & { password: string; passphrase: string };
type PreviewState = { file: FileEntry; connectionName: string; loading: boolean; data: Preview | null; error: string | null };
const emptyPane = (): PaneState => ({ connectionId: '', path: '', draftPath: '', listing: null, loading: true, error: null, selected: null, search: '', sort: 'name', ascending: true, history: [] });
const newForm = (): ConnectForm => ({ name: '', host: '', port: 22, username: '', authMethod: 'key', privateKeyPath: '', password: '', passphrase: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const PROFILE_KEY = 'dropping.connections.v1';
const importedHostKey = (host: SshConfigHost) => JSON.stringify([host.alias, host.host, host.port, host.username, host.authMethod, host.privateKeyPath, host.warning]);

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}
function formatDate(timestamp: number | null) {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.valueOf()) ? '—' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function FileIcon({ entry, size = 18 }: { entry: Pick<FileEntry, 'isDir' | 'name'>; size?: number }) {
  if (entry.isDir) return <Folder size={size} className="file-icon folder-icon" fill="currentColor" fillOpacity=".13" />;
  const extension = entry.name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(extension)) return <FileImage size={size} className="file-icon image-icon" />;
  if (['zip', 'gz', 'tar', '7z', 'rar', 'zst'].includes(extension)) return <FileArchive size={size} className="file-icon archive-icon" />;
  if (['py', 'rs', 'js', 'ts', 'tsx', 'jsx', 'json', 'toml', 'yaml', 'yml', 'sh', 'html', 'css'].includes(extension)) return <FileCode2 size={size} className="file-icon code-icon" />;
  if (['txt', 'md', 'csv', 'log', 'ini'].includes(extension)) return <FileText size={size} className="file-icon" />;
  return <File size={size} className="file-icon" />;
}
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
  const [queueOpen, setQueueOpen] = useState(false);
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
    setQueueOpen(true);
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

  const activeCount = queue.filter(item => item.status === 'queued' || item.status === 'running').length;
  const completedCount = queue.filter(item => item.status === 'completed').length;
  const selectedFile = panes[activeSide].listing?.entries.find(item => item.path === panes[activeSide].selected);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={event => event.preventDefault()} aria-label="Dropping 文件传输">
          <span className="brand-mark"><ArrowDownToLine size={23} strokeWidth={2.6} /></span>
          <span>dropping<span className="brand-dot">.</span></span>
        </a>
        <span className="topbar-divider" />
        <span className="protocol-badge"><LockKeyhole size={12} /> SFTP</span>
        <div className="topbar-actions">
          <button className={`toolbar-button ${showHidden ? 'is-on' : ''}`} onClick={() => setShowHidden(value => !value)} title={showHidden ? '隐藏点文件' : '显示隐藏文件'} aria-pressed={showHidden}>{showHidden ? <Eye size={16} /> : <EyeOff size={16} />}<span>隐藏文件</span></button>
          <button className="toolbar-button" onClick={() => { void reloadSshConfig(); ([0, 1] as Side[]).forEach(side => { const pane = panesRef.current[side]; if (pane.connectionId) void loadDirectory(side, pane.connectionId, pane.path, false); }); }} title="刷新目录与 SSH 配置" disabled={!connections.length}><RefreshCw size={16} /><span>刷新</span></button>
          <span className="action-divider" />
          <button className={`toolbar-button ${queueOpen ? 'is-on' : ''}`} onClick={() => setQueueOpen(value => !value)} aria-expanded={queueOpen}><ArrowLeftRight size={16} /><span>传输队列</span>{activeCount > 0 && <span className="count-badge">{activeCount}</span>}</button>
          <button className="primary-button connect-button" onClick={() => openConnect()}><Plus size={17} />新建连接</button>
        </div>
      </header>

      <main className="main-content">
        <div className="workspace-heading">
          <div><div className="eyebrow">YOUR FILES, CONNECTED</div><h1>文件工作区</h1><div className="ssh-config-status"><span>SSH 配置</span><code title={sshConfig.path}>{sshConfig.path}</code><span>{configLoading ? '正在读取…' : `${sshConfig.hosts.length} 台设备`}</span><button className="config-reload" aria-label="重新读取 SSH 配置" title="重新读取 SSH 配置" disabled={configLoading} onClick={() => void reloadSshConfig()}><RefreshCw size={11} className={configLoading ? 'spin' : ''} /></button>{(configError || sshConfig.warnings.length > 0) && <details className="config-warnings"><summary><CircleAlert size={11} />{configError ? '读取失败，可手动连接' : `${sshConfig.warnings.length} 项提示`}</summary><div>{configError ? <p>{configError}</p> : sshConfig.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></details>}</div></div>
          <div className="workspace-hint"><span>双击文件传输</span><span className="hint-dot">·</span><kbd>Space</kbd><span>快速预览</span></div>
        </div>
        {!isDesktop && <div className="browser-notice"><CircleAlert size={16} /><span>当前为浏览器预览。请运行 Dropping 桌面客户端，使用本机文件与 SSH 连接。</span></div>}
        <div className="workspace">
          {([0, 1] as Side[]).map(side => {
            const pane = panes[side];
            const connection = connections.find(item => item.id === pane.connectionId);
            const entries = visibleEntries(pane, showHidden);
            const selected = pane.listing?.entries.find(item => item.path === pane.selected);
            return (
              <section className={`file-pane ${activeSide === side ? 'active-pane' : ''}`} key={side} onPointerDown={() => setActiveSide(side)} onFocusCapture={() => setActiveSide(side)} aria-label={side === 0 ? '左侧工作区' : '右侧工作区'}>
                <div className="pane-heading">
                  <div className={`endpoint-icon ${connection?.kind === 'ssh' ? 'remote-icon' : ''}`}>{connection?.kind === 'ssh' ? <Server size={20} /> : <Laptop size={21} />}</div>
                  <div className="endpoint-info">
                    <div className="endpoint-selector">
                      <select aria-label={side === 0 ? '左侧设备' : '右侧设备'} value={pane.connectionId} onChange={event => {
                        if (event.target.value === '__new__') { openConnect(side); return; }
                        if (event.target.value.startsWith('ssh:')) {
                          const host = sshConfig.hosts.find(item => item.alias === event.target.value.slice(4));
                          if (host) chooseImportedHost(side, host);
                          return;
                        }
                        const next = connections.find(item => item.id === event.target.value);
                        if (next) void loadDirectory(side, next.id, next.home, false);
                      }}>
                        {!connections.length && <option value="">本机</option>}
                        {connections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                        {sshConfig.hosts.length > 0 && <optgroup label="SSH 配置">{sshConfig.hosts.map(host => <option key={host.alias} value={`ssh:${host.alias}`}>{host.alias}{host.warning ? ' · 需检查配置' : ''}</option>)}</optgroup>}
                        <option value="__new__">＋ 连接另一台设备…</option>
                      </select><ChevronDown size={14} />
                    </div>
                    <span className="endpoint-address">{connection?.kind === 'ssh' ? `${connection.username}@${connection.host}` : '本地文件系统'}</span>
                  </div>
                  <div className="endpoint-state"><span className={`status-dot ${connection ? '' : 'offline'}`} />{connection?.kind === 'ssh' ? '已连接' : connection ? '本机' : '未就绪'}</div>
                  {connection?.kind === 'ssh' && <button className="icon-button disconnect-button" title="断开此 SSH 连接" aria-label="断开此 SSH 连接" onClick={() => void disconnect(connection)}><Unplug size={15} /></button>}
                </div>
                <div className="path-bar">
                  <button className="icon-button" title="返回上一个目录" aria-label="返回上一个目录" disabled={!pane.history.length || pane.loading} onClick={() => {
                    const path = pane.history[pane.history.length - 1];
                    updatePane(side, current => ({ ...current, history: current.history.slice(0, -1) }));
                    void loadDirectory(side, pane.connectionId, path, false);
                  }}><ArrowLeft size={16} /></button>
                  <button className="icon-button" title="上一级目录" aria-label="上一级目录" disabled={!pane.listing?.parent || pane.loading} onClick={() => { if (pane.listing?.parent) void loadDirectory(side, pane.connectionId, pane.listing.parent); }}><ArrowUp size={16} /></button>
                  <form className="path-input-wrap" onSubmit={event => { event.preventDefault(); if (pane.draftPath.trim() && pane.connectionId) void loadDirectory(side, pane.connectionId, pane.draftPath.trim()); }}><Folder size={14} /><input aria-label={side === 0 ? '左侧目录路径' : '右侧目录路径'} value={pane.draftPath} placeholder="输入目录路径" spellCheck={false} onChange={event => updatePane(side, current => ({ ...current, draftPath: event.target.value }))} disabled={!connection} /><button type="submit" className="path-submit" aria-label="打开目录" disabled={!connection}><ChevronRight size={14} /></button></form>
                  <button className="icon-button" title="刷新目录" aria-label="刷新目录" disabled={!pane.connectionId || pane.loading} onClick={() => void loadDirectory(side, pane.connectionId, pane.path, false)}><RefreshCw size={15} className={pane.loading ? 'spin' : ''} /></button>
                </div>
                <div className="pane-tools"><label className="search-field"><Search size={14} /><input placeholder="筛选当前目录" aria-label={side === 0 ? '筛选左侧文件' : '筛选右侧文件'} value={pane.search} onChange={event => updatePane(side, current => ({ ...current, search: event.target.value, selected: null }))} />{pane.search && <button className="clear-search" aria-label="清除筛选" onClick={() => updatePane(side, current => ({ ...current, search: '' }))}><X size={12} /></button>}</label><span>{entries.length} 个项目</span></div>
                <div className="file-table-wrap" tabIndex={0} aria-label={side === 0 ? '左侧文件列表，空格预览，回车打开或传输' : '右侧文件列表，空格预览，回车打开或传输'}>
                  <table className="file-table"><thead><tr>{([{ key: 'name', label: '名称' }, { key: 'size', label: '大小' }, { key: 'modified', label: '修改时间' }] as { key: SortKey; label: string }[]).map(column => <th key={column.key} className={`column-${column.key}`} aria-sort={pane.sort === column.key ? pane.ascending ? 'ascending' : 'descending' : 'none'}><button onClick={() => updatePane(side, current => ({ ...current, sort: column.key, ascending: current.sort === column.key ? !current.ascending : true }))}>{column.label}{pane.sort === column.key && <ChevronDown size={12} className={pane.ascending ? 'sort-ascending' : ''} />}</button></th>)}</tr></thead>
                    <tbody>{!pane.error && entries.map(entry => <tr key={entry.path} className={pane.selected === entry.path ? 'selected-row' : ''} aria-selected={pane.selected === entry.path} onClick={() => updatePane(side, current => ({ ...current, selected: entry.path }))} onDoubleClick={() => { if (pane.loading) return; if (entry.isDir) void loadDirectory(side, pane.connectionId, entry.path); else enqueue(side, entry); }}><td><span className="file-name" title={entry.name}><FileIcon entry={entry} /><span>{entry.name}</span>{entry.isSymlink && <span className="symlink-label" title="符号链接">↗</span>}</span></td><td className="file-size">{entry.isDir ? '—' : formatSize(entry.size)}</td><td className="file-date">{formatDate(entry.modified)}</td></tr>)}</tbody>
                  </table>
                  {pane.loading && <div className={`pane-empty ${pane.listing ? 'loading-overlay' : ''}`}><LoaderCircle size={24} className="spin" /><strong>正在读取目录</strong><span>文件即将显示在这里</span></div>}
                  {!pane.loading && pane.error && <div className="pane-empty error-state"><span className="empty-symbol"><CircleAlert size={26} /></span><strong>{isDesktop ? '暂时无法打开目录' : '等待桌面客户端'}</strong><p>{isDesktop ? pane.error : '在桌面客户端中浏览本机目录，或通过 SFTP 连接远程设备。'}</p>{pane.connectionId && <button className="secondary-button" onClick={() => void loadDirectory(side, pane.connectionId, pane.draftPath || pane.path, false)}><RefreshCw size={14} />重试</button>}</div>}
                  {!pane.loading && !pane.error && entries.length === 0 && <div className="pane-empty"><span className="empty-symbol"><Folder size={29} /></span><strong>{pane.search ? '没有匹配的文件' : '这个目录很干净'}</strong><p>{pane.search ? '试试其他文件名，或清除筛选。' : '从另一侧选择文件，双击即可传入这里。'}</p></div>}
                </div>
                <div className="pane-footer"><span>{selected ? <><span className="selected-indicator" />{selected.isDir ? '已选择文件夹' : formatSize(selected.size)}</> : <><HardDrive size={12} />{side === 0 ? '左侧工作区' : '右侧工作区'}</>}</span><div><button disabled={!selected || selected.isDir || pane.loading || !!pane.error} onClick={() => void openPreview(side)} title="空格键预览"><Eye size={14} />预览</button><button className="pane-transfer" disabled={!selected || pane.loading || !!pane.error || panes[side === 0 ? 1 : 0].loading || !panes[side === 0 ? 1 : 0].listing || !!panes[side === 0 ? 1 : 0].error} onClick={() => enqueue(side)}>{side === 1 && <ArrowLeft size={14} />}传到{side === 0 ? '右侧' : '左侧'}{side === 0 && <ArrowRight size={14} />}</button></div></div>
              </section>
            );
          })}
          <div className="workspace-link" title="文件经当前电脑中转"><ArrowLeftRight size={14} /></div>
        </div>

        <section className={`transfer-panel ${queueOpen ? 'is-expanded' : ''}`} aria-label="传输队列">
          <div className="transfer-heading"><button className="queue-toggle" onClick={() => setQueueOpen(value => !value)} aria-expanded={queueOpen}><ArrowLeftRight size={16} /><strong>传输队列</strong>{activeCount > 0 ? <span className="queue-count">{activeCount} 进行中</span> : <span className="queue-idle">{queue.length ? `${completedCount} 项已完成` : '暂无任务'}</span>}<ChevronDown size={15} className={queueOpen ? 'chevron-up' : ''} /></button><div className="queue-actions">{queueOpen && queue.some(item => !['queued', 'running'].includes(item.status)) && <button className="text-button" onClick={() => setQueue(current => current.filter(item => ['queued', 'running'].includes(item.status)))}>清除已结束</button>}<span className="secure-transfer"><ShieldCheck size={13} />SSH 加密传输</span></div></div>
          {queueOpen && <div className="queue-body">{queue.length === 0 ? <div className="queue-empty"><Copy size={22} /><div><strong>下一份文件，即刻出发</strong><span>双击文件，或选中文件夹后点击「传到另一侧」。</span></div></div> : [...queue].reverse().map(item => {
            const percentage = item.totalBytes > 0 ? Math.min(100, Math.round(item.bytesTransferred / item.totalBytes * 100)) : item.status === 'completed' ? 100 : 0;
            const labels = { queued: '排队中', running: '正在传输', completed: '已完成', failed: '失败', cancelled: '已取消' };
            return <div className={`queue-row queue-${item.status}`} key={item.id}><div className="queue-file-icon"><FileIcon entry={item} size={20} /></div><div className="queue-file"><strong title={item.sourcePath}>{item.name}</strong><span title={`${item.sourcePath} → ${item.destinationDirectory}`}>{item.sourceName}<ArrowRight size={11} />{item.destinationName}<span className="queue-target">{item.destinationDirectory}</span></span>{item.error && <p className="queue-error">{item.error}</p>}</div><div className="queue-progress"><div className="progress-label"><span>{labels[item.status]}</span><span>{item.status === 'running' ? `${formatSize(item.bytesTransferred)} / ${formatSize(item.totalBytes)}` : item.status === 'completed' ? `${formatSize(item.bytesTransferred)} · ${item.filesTransferred} 个文件` : ''}</span></div><div className="progress-track"><div className={item.status === 'running' && !item.totalBytes ? 'indeterminate-progress' : ''} style={{ width: `${percentage}%` }} /></div></div><div className="queue-row-action">{['running', 'queued'].includes(item.status) ? <button className="icon-button" aria-label={`取消 ${item.name}`} title="取消传输" onClick={() => void cancel(item)}><X size={15} /></button> : item.status === 'completed' ? <CheckCircle2 size={17} className="success-icon" /> : item.status === 'failed' ? <CircleAlert size={17} className="error-icon" /> : <span className="cancelled-dash">—</span>}</div></div>;
          })}</div>}
        </section>
        <footer className="app-footer"><span><span className={`status-dot ${isDesktop ? '' : 'offline'}`} />{isDesktop ? '准备就绪' : '浏览器预览'}<span className="footer-separator">/</span>{connections.filter(connection => connection.kind === 'ssh').length} 个远程连接</span><span>{selectedFile ? `已选择 ${selectedFile.name}` : '文件保留在源设备 · 同名文件不会覆盖'}</span><span>Dropping <span className="version">v0.1.1</span></span></footer>
      </main>

      {notification && <div className={`toast ${notification.error ? 'toast-error' : ''}`} role={notification.error ? 'alert' : 'status'}>{notification.error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}<span>{notification.text}</span><button className="icon-button" onClick={() => setNotification(null)} aria-label="关闭提示"><X size={14} /></button></div>}

      {connectOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !connectionBusy) setConnectOpen(false); }}><section className="connection-modal" role="dialog" aria-modal="true" aria-labelledby="connection-title"><div className="modal-heading"><div className="modal-heading-icon"><Server size={21} /></div><div><h2 id="connection-title">{hostKey ? '确认服务器身份' : '连接远程设备'}</h2><p>{hostKey ? '建立连接前，请核对 SSH 主机指纹。' : '通过 SFTP，安全访问另一台电脑的文件。'}</p></div><button className="icon-button modal-close" onClick={() => setConnectOpen(false)} disabled={connectionBusy} aria-label="关闭连接窗口"><X size={19} /></button></div>
        {!hostKey ? <form onSubmit={event => void probeConnection(event)} className="connection-form"><fieldset disabled={connectionBusy}>
          <label className="form-field">连接来源<select value={formSource} onChange={event => {
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
          }}><option value="manual">手动填写连接信息</option>{sshConfig.hosts.length > 0 && <optgroup label="SSH 配置">{sshConfig.hosts.map(host => <option key={host.alias} value={`ssh:${host.alias}`}>{host.alias} · {host.username}@{host.host}{host.warning ? ' · 需检查配置' : ''}</option>)}</optgroup>}{profiles.length > 0 && <optgroup label="已保存的连接">{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.username}`} value={`saved:${index}`}>{profile.name || profile.host} · {profile.username}@{profile.host}</option>)}</optgroup>}</select></label>
          {importedProfile && <div className="import-source-note"><FileCode2 size={13} /><span title={sshConfig.path}>来自 {sshConfig.path}；修改参数请切换手动填写。</span></div>}
          {importedProfile?.warning && <div className="form-error" role="alert"><CircleAlert size={16} /><span>此配置暂不能直接连接：{importedProfile.warning}</span></div>}
          <label className="form-field">连接名称 <span className="optional-label">可选</span><input placeholder="例如：研究服务器" autoFocus readOnly={!!importedProfile} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
          <div className="form-grid"><label className="form-field">主机地址<input required readOnly={!!importedProfile} placeholder="192.168.1.100 或 example.com" value={form.host} onChange={event => setForm(current => ({ ...current, host: event.target.value }))} spellCheck={false} /></label><label className="form-field">端口<input type="number" min="1" max="65535" required readOnly={!!importedProfile} value={form.port} onChange={event => setForm(current => ({ ...current, port: Number(event.target.value) }))} /></label></div>
          <label className="form-field">用户名<input required readOnly={!!importedProfile} autoComplete="username" placeholder="请输入 SSH 用户名" value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} spellCheck={false} /></label>
          <div className="auth-switch" role="group" aria-label="认证方式"><button type="button" disabled={!!importedProfile} className={form.authMethod === 'key' ? 'selected-auth' : ''} onClick={() => setForm(current => ({ ...current, authMethod: 'key' }))}><KeyRound size={15} />SSH 私钥</button><button type="button" disabled={!!importedProfile} className={form.authMethod === 'password' ? 'selected-auth' : ''} onClick={() => setForm(current => ({ ...current, authMethod: 'password' }))}><LockKeyhole size={15} />密码</button></div>
          {form.authMethod === 'key' ? <><label className="form-field">本机私钥路径<input required readOnly={!!importedProfile} placeholder="C:\Users\you\.ssh\id_ed25519" value={form.privateKeyPath || ''} onChange={event => setForm(current => ({ ...current, privateKeyPath: event.target.value }))} spellCheck={false} /></label><label className="form-field">私钥口令 <span className="optional-label">可选</span><input type="password" autoComplete="off" placeholder="私钥已加密时填写" value={form.passphrase} onChange={event => setForm(current => ({ ...current, passphrase: event.target.value }))} /></label></> : <label className="form-field">密码<input type="password" required autoComplete="current-password" placeholder="请输入 SSH 密码" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label>}
          {connectionError && <div className="form-error" role="alert"><CircleAlert size={16} /><span>{connectionError}</span></div>}
          <div className="form-note"><LockKeyhole size={13} />密码和私钥口令仅用于本次连接，不会保存。</div>
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setConnectOpen(false)} disabled={connectionBusy}>取消</button><button className="primary-button" type="submit" disabled={connectionBusy || !!importedProfile?.warning}>{connectionBusy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}{connectionBusy ? '正在检查服务器…' : '继续连接'}</button></div>
        </fieldset></form> : <div className="fingerprint-content"><div className="fingerprint-shield"><ShieldCheck size={34} /></div><h3>{form.host}:{form.port}</h3><p>请与服务器管理员提供的指纹核对。只有指纹一致时，才应信任这个连接。</p><div className="fingerprint-box"><span>{hostKey.keyType} · 主机指纹</span><code>{hostKey.fingerprint}</code></div><p className="fingerprint-help">可在服务器上使用 ssh-keygen -lf 查看主机公钥指纹。</p>{connectionError && <div className="form-error" role="alert"><CircleAlert size={16} /><span>{connectionError}</span></div>}<div className="modal-actions"><button className="secondary-button" onClick={() => { setHostKey(null); setConnectionError(null); }} disabled={connectionBusy}>返回修改</button><button className="primary-button" onClick={() => void confirmConnection()} disabled={connectionBusy}>{connectionBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{connectionBusy ? '正在连接…' : '信任并连接'}</button></div></div>}
      </section></div>}

      {preview && <div className="modal-backdrop preview-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closePreview(); }}><section className="preview-modal" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div className="preview-heading"><FileIcon entry={preview.file} size={22} /><div><h2 id="preview-title">{preview.file.name}</h2><p>{preview.connectionName}<span>·</span>{formatSize(preview.file.size)}</p></div><span className="preview-key-hint"><kbd>Esc</kbd> 关闭</span><button className="icon-button" aria-label="关闭预览" onClick={closePreview}><X size={20} /></button></div><div className={`preview-content ${preview.data?.kind === 'image' ? 'image-preview' : ''}`}>
        {preview.loading ? <div className="preview-empty"><LoaderCircle size={28} className="spin" /><strong>正在加载预览</strong></div> : preview.error ? <div className="preview-empty error-state"><CircleAlert size={30} /><strong>无法预览这个文件</strong><p>{preview.error}</p></div> : preview.data?.kind === 'text' ? <pre className="text-preview"><code>{preview.data.content}</code></pre> : preview.data?.kind === 'image' ? <img src={preview.data.content.startsWith('data:') ? preview.data.content : `data:${preview.data.mime};base64,${preview.data.content}`} alt={preview.file.name} /> : <div className="preview-empty"><File size={38} /><strong>暂时无法预览此文件</strong><p>{preview.data?.content || '支持常见文本、代码文件及图片。你仍然可以将文件传输到其他设备。'}</p></div>}
      </div><div className="preview-footer"><span title={preview.file.path}>{preview.file.path}</span>{preview.data?.kind === 'text' && preview.data.truncated && <span className="truncated-notice">文件较大，仅展示开头内容</span>}<span>只读预览</span></div></section></div>}
    </div>
  );
}
