import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, CircleAlert, ClipboardPaste, CodeXml, Copy, CornerLeftUp, Eye,
  FolderOpen, FolderPlus, Info, Laptop, Link, List, LoaderCircle, Pencil, Plus, RefreshCw, Scissors, Search, Server, SquareArrowOutUpRight, Trash2, X,
} from 'lucide-react';
import { api, appWindow, isDesktop, onTransferProgress } from './bridge';
import AddressBar from './AddressBar';
import DevicePicker from './DevicePicker';
import FileToolbar from './FileToolbar';
import ContextMenu, { type ContextAction } from './ContextMenu';
import { FileIcon, formatDate, formatSize } from './files';
import PreviewContent, { DataTable, previewFormat } from './PreviewContent';
import { parseDelimited, readParquetPreview, type TablePreview } from './tables';
import TransferQueue, { type QueueItem } from './TransferQueue';
import type { Connection, DirectoryListing, FileEntry, HostKey, Preview, SshConfig, SshConfigHost, SshConfigHosts } from './types';
import { version } from '../package.json';
import './App.css';

type Side = 0 | 1;
type SortKey = 'name' | 'size' | 'modified';
type PaneState = {
  connectionId: string; path: string; draftPath: string; listing: DirectoryListing | null;
  loading: boolean; error: string | null; selected: string | null; search: string;
  sort: SortKey; ascending: boolean; history: string[]; showHidden: boolean; compact: boolean;
};
/** Each pane holds browser-style tabs; every tab keeps its own device, folder and view state. */
type Tab = PaneState & { id: string };
type SideTabs = { tabs: Tab[]; active: string };
/** Where a chosen device opens: an existing tab, or a new tab when `tab` is null. */
type Target = { side: Side; tab: string | null };
type Profile = Pick<SshConfig, 'name' | 'host' | 'port' | 'username' | 'authMethod' | 'privateKeyPath'>;
type ConnectForm = Profile & { password: string; passphrase: string };
type PreviewState = { file: FileEntry; connectionName: string; loading: boolean; data: Preview | null; table: TablePreview | null; error: string | null };
const isWindowChrome = (target: EventTarget) => !(target instanceof Element && target.closest('button, input, select, a, [role="dialog"]'));
const emptyPane = (): PaneState => ({ connectionId: '', path: '', draftPath: '', listing: null, loading: true, error: null, selected: null, search: '', sort: 'name', ascending: true, history: [], showHidden: false, compact: false });
const newTab = (): Tab => ({ ...emptyPane(), id: crypto.randomUUID() });
const newSide = (): SideTabs => { const tab = newTab(); return { tabs: [tab], active: tab.id }; };
const activeOf = (side: SideTabs) => side.tabs.find(tab => tab.id === side.active) ?? side.tabs[0];
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const newForm = (): ConnectForm => ({ name: '', host: '', port: 22, username: '', authMethod: 'key', privateKeyPath: '', password: '', passphrase: '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const PROFILE_KEY = 'dropping.connections.v1';
/** Host keys the user has explicitly trusted, keyed by `host:port` (fingerprints only, never secrets). */
const KNOWN_HOSTS_KEY = 'dropping.known-hosts.v1';
type KnownHost = { fingerprint: string; keyType: string };
type FileClipboard = { mode: 'copy' | 'cut'; connectionId: string; directory: string; file: FileEntry };
type FileDialog = { kind: 'new' | 'rename' | 'delete' | 'properties'; connectionId: string; directory: string; file?: FileEntry };
type WorkspaceMenu = { id: string; side: Side; tabId: string; directory: string; selected: string | null; x: number; y: number };
const hostId = (host: string, port: number) => `${host.trim().toLowerCase()}:${port}`;
const isHandshakeFailure = (error: unknown) => messageOf(error).includes('SSH 握手失败');
/** Errors from a remote operation that mean the session itself is gone, not just one path failing. */
const DISCONNECTED = /连接已断开|断开|disconnect|channel closed|connection closed|session closed|broken pipe|reset by peer|timed out|超时|eof/i;
const profileKey = (profile: Pick<Profile, 'host' | 'port' | 'username'>) => `${profile.username}@${profile.host}:${profile.port}`;
const importedHostKey = (host: SshConfigHost) => JSON.stringify([host.alias, host.host, host.port, host.username, host.authMethod, host.privateKeyPath, host.warning]);

/** Selection key of the `..` row; cannot collide with a real path. */
const PARENT_ROW = '\u0000parent';
function visibleEntries(pane: PaneState) {
  return (pane.listing?.entries || [])
    .filter(entry => (pane.showHidden || !entry.name.startsWith('.')) && entry.name.toLocaleLowerCase().includes(pane.search.toLocaleLowerCase()))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const comparison = pane.sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : (a[pane.sort] || 0) - (b[pane.sort] || 0);
      return pane.ascending ? comparison : -comparison;
    });
}
function readKnownHosts(): Record<string, KnownHost> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KNOWN_HOSTS_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, KnownHost] => {
      const host = entry[1] as Partial<KnownHost> | null;
      return !!host && typeof host.fingerprint === 'string' && host.fingerprint.startsWith('SHA256:') && typeof host.keyType === 'string';
    }));
  } catch { return {}; }
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
  const [sides, setSides] = useState<[SideTabs, SideTabs]>(() => [newSide(), newSide()]);
  const sidesRef = useRef(sides);
  const connectionsRef = useRef(connections);
  const localRef = useRef<Connection | null>(null);
  const requests = useRef(new Map<string, number>());
  const [activeSide, setActiveSide] = useState<Side>(0);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const pending = useRef<QueueItem[]>([]);
  const running = useRef<string | null>(null);
  const cancelled = useRef(new Set<string>());
  const [notification, setNotification] = useState<{ text: string; error: boolean } | null>(null);
  /** Sticky status-bar problem (failed transfer, dropped connection) until the user dismisses it. */
  const [statusError, setStatusError] = useState<{ text: string; transfer: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<Target>({ side: 1, tab: null });
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
  const [changedFrom, setChangedFrom] = useState<KnownHost | null>(null);
  const knownHosts = useRef(readKnownHosts());
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewSource, setPreviewSource] = useState(false);
  const previewRequest = useRef(0);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null);
  const [fileDialog, setFileDialog] = useState<FileDialog | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const fileLock = useRef(false);
  const fileDialogRef = useRef<HTMLElement>(null);
  const fileLists = useRef<(HTMLDivElement | null)[]>([]);
  const [contextMenu, setContextMenu] = useState<WorkspaceMenu | null>(null);

  const commitSides = useCallback((next: [SideTabs, SideTabs]) => { sidesRef.current = next; setSides(next); }, []);
  const paneAt = useCallback((side: Side) => activeOf(sidesRef.current[side]), []);
  const updateTab = useCallback((side: Side, tabId: string, updater: (pane: PaneState) => PaneState) => {
    const next: [SideTabs, SideTabs] = [...sidesRef.current];
    next[side] = { ...next[side], tabs: next[side].tabs.map(tab => tab.id === tabId ? { ...updater(tab), id: tab.id } : tab) };
    commitSides(next);
  }, [commitSides]);
  const updatePane = useCallback((side: Side, updater: (pane: PaneState) => PaneState) => updateTab(side, paneAt(side).id, updater), [paneAt, updateTab]);
  const notify = useCallback((text: string, error = false) => {
    setNotification({ text, error });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotification(null), error ? 9000 : 4500);
  }, []);
  const reportRemoteFailure = useCallback((connectionId: string, error: unknown) => {
    const connection = connectionsRef.current.find(item => item.id === connectionId);
    const message = messageOf(error);
    if (connection?.kind === 'ssh' && DISCONNECTED.test(message)) setStatusError({ text: `${connection.name} 连接异常：${message}`, transfer: false });
  }, []);
  const loadDirectory = useCallback(async (side: Side, connectionId: string, path: string, addHistory = true, tabId = paneAt(side).id) => {
    const previous = sidesRef.current[side].tabs.find(tab => tab.id === tabId);
    if (!previous) return;
    const token = (requests.current.get(tabId) ?? 0) + 1;
    requests.current.set(tabId, token);
    updateTab(side, tabId, current => ({ ...current, connectionId, loading: true, error: null, selected: null,
      ...(connectionId !== current.connectionId ? { listing: null, history: [], path, draftPath: path, search: '' } : {}),
    }));
    try {
      const listing = await api.listDirectory(connectionId, path);
      if (requests.current.get(tabId) !== token) return;
      updateTab(side, tabId, current => ({ ...current, loading: false, listing, path: listing.path, draftPath: listing.path, error: null,
        history: addHistory && previous.connectionId === connectionId && previous.path && previous.path !== listing.path ? [...previous.history, previous.path] : current.history,
      }));
    } catch (error) {
      if (requests.current.get(tabId) !== token) return;
      updateTab(side, tabId, current => ({ ...current, loading: false, error: messageOf(error), draftPath: path }));
      reportRemoteFailure(connectionId, error);
    }
  }, [paneAt, reportRemoteFailure, updateTab]);
  const eachTab = useCallback((visit: (side: Side, tab: Tab) => void) => {
    ([0, 1] as Side[]).forEach(side => sidesRef.current[side].tabs.forEach(tab => visit(side, tab)));
  }, []);
  const activateTab = (side: Side, tabId: string) => {
    const next: [SideTabs, SideTabs] = [...sidesRef.current];
    next[side] = { ...next[side], active: tabId };
    commitSides(next);
    setActiveSide(side);
  };
  const addTab = (side: Side, connection: Connection, path: string) => {
    const tab = newTab();
    const next: [SideTabs, SideTabs] = [...sidesRef.current];
    next[side] = { tabs: [...next[side].tabs, tab], active: tab.id };
    commitSides(next);
    setActiveSide(side);
    void loadDirectory(side, connection.id, path, false, tab.id);
  };
  const closeTab = (side: Side, tabId: string) => {
    const { tabs, active } = sidesRef.current[side];
    if (tabs.length <= 1) return;
    const index = tabs.findIndex(tab => tab.id === tabId);
    const remaining = tabs.filter(tab => tab.id !== tabId);
    const next: [SideTabs, SideTabs] = [...sidesRef.current];
    next[side] = { tabs: remaining, active: active === tabId ? remaining[Math.min(index, remaining.length - 1)].id : active };
    requests.current.delete(tabId);
    commitSides(next);
  };

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
    eachTab((side, tab) => {
      if (tab.connectionId === item.destinationConnectionId && tab.path === item.destinationDirectory) void loadDirectory(side, tab.connectionId, tab.path, false, tab.id);
    });
  }, [eachTab, loadDirectory]);
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
        if (visibleError && !wasCancelled) setStatusError({ text: `${item.name} 传输失败：${visibleError}`, transfer: true });
        refreshDestination(item);
      } finally {
        cancelled.current.delete(item.id);
        running.current = null;
      }
    }
  }, [notify, refreshDestination]);

  const enqueue = useCallback((side: Side, entry?: FileEntry) => {
    const source = paneAt(side);
    const destination = paneAt(side === 0 ? 1 : 0);
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
  }, [notify, paneAt, runQueue]);

  const refreshFolder = useCallback((connectionId: string, directory: string) => {
    eachTab((side, tab) => {
      if (tab.connectionId === connectionId && tab.path === directory) void loadDirectory(side, connectionId, directory, false, tab.id);
    });
  }, [eachTab, loadDirectory]);
  const openFileDialog = useCallback((side: Side, kind: FileDialog['kind']) => {
    const pane = paneAt(side);
    if (!pane.listing || pane.loading || pane.error || fileLock.current) return;
    const file = pane.listing.entries.find(entry => entry.path === pane.selected);
    if (kind !== 'new' && !file) return;
    if (file?.isSymlink && kind !== 'properties') { notify('暂不操作符号链接，请选择普通文件或文件夹。', true); return; }
    setFileName(kind === 'new' ? '新建文件夹' : file?.name || '');
    setFileError(null);
    setFileDialog({ kind, connectionId: pane.connectionId, directory: pane.path, file });
  }, [notify, paneAt]);
  const closeFileDialog = useCallback(() => {
    if (fileLock.current) return;
    setFileDialog(null);
    fileLists.current[activeSide]?.focus();
  }, [activeSide]);
  const submitFileDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!fileDialog || fileLock.current || fileDialog.kind === 'properties') return;
    const { kind, connectionId, directory, file } = fileDialog;
    const name = fileName;
    if (kind !== 'delete' && (!name.trim() || name === '.' || name === '..' || /[\\/\0]/.test(name))) {
      setFileError('请输入有效的名称，不能包含路径分隔符。'); return;
    }
    if (kind === 'rename' && name === file?.name) { closeFileDialog(); return; }
    fileLock.current = true;
    setFileBusy(true);
    setFileError(null);
    try {
      if (kind === 'new') await api.createFolder(connectionId, directory, name);
      else if (kind === 'rename' && file) await api.renameEntry(connectionId, directory, file.name, name);
      else if (kind === 'delete' && file) await api.deleteEntry(connectionId, directory, file.name);
      setFileClipboard(current => current?.connectionId === connectionId && current.file.path === file?.path ? null : current);
      setFileDialog(null);
      notify(kind === 'new' ? `已新建 ${name}` : kind === 'rename' ? `已重命名为 ${name}` : `已删除 ${file?.name}`);
      fileLists.current[activeSide]?.focus();
    } catch (error) {
      setFileError(messageOf(error));
      reportRemoteFailure(connectionId, error);
    } finally {
      fileLock.current = false;
      setFileBusy(false);
      refreshFolder(connectionId, directory);
    }
  };
  const copyFile = useCallback((side: Side, mode: FileClipboard['mode']) => {
    const pane = paneAt(side);
    const file = pane.listing?.entries.find(entry => entry.path === pane.selected);
    if (!file || pane.loading || pane.error || fileLock.current) return;
    if (file.isSymlink) { notify('暂不复制或剪切符号链接。', true); return; }
    setFileClipboard({ mode, connectionId: pane.connectionId, directory: pane.path, file });
    notify(mode === 'cut' ? `已剪切 ${file.name}，请在同一设备的目标目录粘贴。` : `已复制 ${file.name}，请在目标目录粘贴。`);
  }, [notify, paneAt]);
  const pasteFile = useCallback(async (side: Side, directory?: string) => {
    const pane = paneAt(side);
    const destinationDirectory = directory ?? pane.path;
    const clipboard = fileClipboard;
    if (!clipboard || !pane.listing || pane.loading || pane.error || fileLock.current) return;
    const sourceConnection = connectionsRef.current.find(item => item.id === clipboard.connectionId);
    const destinationConnection = connectionsRef.current.find(item => item.id === pane.connectionId);
    if (!sourceConnection || !destinationConnection) { notify('源设备已断开，请重新复制。', true); return; }
    if (clipboard.connectionId === pane.connectionId && clipboard.directory === destinationDirectory) { notify('源目录与目标目录相同，请选择另一个目录。', true); return; }
    if (clipboard.mode === 'cut') {
      if (clipboard.connectionId !== pane.connectionId) { notify('剪切只支持同一设备内移动；跨设备请使用复制粘贴。', true); return; }
      fileLock.current = true;
      setFileBusy(true);
      try {
        await api.moveEntry(clipboard.connectionId, clipboard.directory, clipboard.file.name, destinationDirectory);
        setFileClipboard(null);
        notify(`已移动 ${clipboard.file.name}`);
      } catch (error) { notify(`移动失败：${messageOf(error)}`, true); reportRemoteFailure(pane.connectionId, error); }
      finally {
        fileLock.current = false;
        setFileBusy(false);
        refreshFolder(clipboard.connectionId, clipboard.directory);
        refreshFolder(pane.connectionId, destinationDirectory);
      }
      return;
    }
    const item: QueueItem = {
      id: crypto.randomUUID(), name: clipboard.file.name, isDir: clipboard.file.isDir, sourceName: sourceConnection.name,
      destinationName: destinationConnection.name, sourceConnectionId: clipboard.connectionId,
      destinationConnectionId: pane.connectionId, sourcePath: clipboard.file.path, destinationDirectory,
      status: 'queued', bytesTransferred: 0, totalBytes: clipboard.file.isDir ? 0 : clipboard.file.size,
      filesTransferred: 0, totalFiles: clipboard.file.isDir ? 0 : 1, currentFile: clipboard.file.name,
    };
    pending.current.push(item);
    setQueue(current => [...current, item]);
    void runQueue();
  }, [fileClipboard, notify, paneAt, refreshFolder, reportRemoteFailure, runQueue]);
  const copyPath = useCallback(async (side: Side) => {
    const pane = paneAt(side);
    if (!pane.listing || pane.loading || pane.error) return;
    const path = pane.listing.entries.find(entry => entry.path === pane.selected)?.path || pane.path;
    try { await navigator.clipboard.writeText(path); notify('路径已复制'); }
    catch (error) { notify(`复制路径失败：${messageOf(error)}`, true); }
  }, [notify, paneAt]);

  const openContextMenu = (side: Side, selected: string | null, x: number, y: number) => {
    if (connectOpen || fileDialog || preview) return;
    const pane = paneAt(side);
    updatePane(side, current => ({ ...current, selected }));
    setActiveSide(side);
    setContextMenu({ id: crypto.randomUUID(), side, tabId: pane.id, directory: pane.path, selected, x, y });
  };
  const closeContextMenu = (restoreFocus = false) => {
    setContextMenu(null);
    if (restoreFocus && contextMenu) fileLists.current[contextMenu.side]?.focus();
  };
  useEffect(() => {
    if (!contextMenu) return;
    const pane = activeOf(sides[contextMenu.side]);
    if (pane.id !== contextMenu.tabId || pane.path !== contextMenu.directory || pane.selected !== contextMenu.selected || pane.loading || activeSide !== contextMenu.side || fileDialog || preview || connectOpen) setContextMenu(null);
  }, [activeSide, connectOpen, contextMenu, fileDialog, preview, sides]);

  useEffect(() => {
    if (!fileDialog) return;
    const dialog = fileDialogRef.current;
    const input = dialog?.querySelector('input');
    if (input) {
      input.focus();
      input.setSelectionRange(0, fileDialog.kind === 'rename' && !fileDialog.file?.isDir && fileName.lastIndexOf('.') > 0 ? fileName.lastIndexOf('.') : fileName.length);
    } else dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [fileDialog]);

  const openPreview = useCallback(async (side: Side, file?: FileEntry) => {
    const pane = paneAt(side);
    const entry = file || pane.listing?.entries.find(item => item.path === pane.selected);
    if (!entry || entry.isDir || pane.loading || pane.error) return;
    const request = ++previewRequest.current;
    setPreviewSource(false);
    setPreview({ file: entry, connectionName: connectionsRef.current.find(connection => connection.id === pane.connectionId)?.name || '', loading: true, data: null, table: null, error: null });
    try {
      if (previewFormat(entry.name).format === 'parquet') {
        const table = await readParquetPreview((offset, length) => api.readFileRange(pane.connectionId, entry.path, offset, length), entry.size)
          .catch(error => { throw new Error(`无法解析 Parquet 文件：${messageOf(error)}`); });
        if (request === previewRequest.current) setPreview(current => current ? { ...current, loading: false, table } : null);
        return;
      }
      const data = await api.previewFile(pane.connectionId, entry.path);
      if (request === previewRequest.current) setPreview(current => current ? { ...current, loading: false, data } : null);
    } catch (error) {
      if (request === previewRequest.current) setPreview(current => current ? { ...current, loading: false, error: messageOf(error) } : null);
      reportRemoteFailure(pane.connectionId, error);
    }
  }, [paneAt, reportRemoteFailure]);
  const closePreview = useCallback(() => { ++previewRequest.current; setPreview(null); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (fileDialog) closeFileDialog();
        else if (preview) closePreview();
        else if (connectOpen && !connectionBusy) setConnectOpen(false);
        return;
      }
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName));
      if (preview && event.code === 'Space' && !typing) { event.preventDefault(); closePreview(); return; }
      if (connectOpen || preview || fileDialog || contextMenu || event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName))) return;
      const pane = paneAt(activeSide);
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && event.shiftKey && key === 'n') { event.preventDefault(); openFileDialog(activeSide, 'new'); return; }
      if (modifier && event.shiftKey && key === 'c') { event.preventDefault(); void copyPath(activeSide); return; }
      if (modifier && (key === 'c' || key === 'x')) { event.preventDefault(); copyFile(activeSide, key === 'x' ? 'cut' : 'copy'); return; }
      if (modifier && key === 'v') { event.preventDefault(); void pasteFile(activeSide); return; }
      if (event.key === 'F2') { event.preventDefault(); openFileDialog(activeSide, 'rename'); return; }
      if (event.key === 'Delete') { event.preventDefault(); openFileDialog(activeSide, 'delete'); return; }
      if (event.altKey && event.key === 'Enter') { event.preventDefault(); openFileDialog(activeSide, 'properties'); return; }
      if (event.key === 'F5') { event.preventDefault(); if (pane.connectionId && !pane.loading) void loadDirectory(activeSide, pane.connectionId, pane.path, false); return; }
      if (event.code === 'Space') { event.preventDefault(); void openPreview(activeSide); }
      if (event.key === 'Enter') {
        if (pane.selected === PARENT_ROW && pane.listing?.parent && !pane.loading) {
          event.preventDefault();
          void loadDirectory(activeSide, pane.connectionId, pane.listing.parent);
          return;
        }
        const entry = pane.listing?.entries.find(file => file.path === pane.selected);
        if (!entry || pane.loading || pane.error) return;
        event.preventDefault();
        if (entry.isDir) void loadDirectory(activeSide, pane.connectionId, entry.path);
        else enqueue(activeSide, entry);
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const rows = [...(pane.listing?.parent && !pane.error ? [PARENT_ROW] : []), ...visibleEntries(pane).map(file => file.path)];
        const current = rows.indexOf(pane.selected ?? '');
        const next = event.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : Math.max(current - 1, 0);
        if (rows[next]) updatePane(activeSide, state => ({ ...state, selected: rows[next] }));
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (pane.connectionId) void loadDirectory(activeSide, pane.connectionId, pane.path, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSide, closeFileDialog, closePreview, connectOpen, connectionBusy, contextMenu, copyFile, copyPath, enqueue, fileDialog, loadDirectory, openFileDialog, openPreview, paneAt, pasteFile, preview, updatePane]);

  const openIn = (target: Target, connection: Connection) => {
    setActiveSide(target.side);
    if (target.tab === null) addTab(target.side, connection, connection.home);
    else void loadDirectory(target.side, connection.id, connection.home, false, target.tab);
  };
  const resetDialog = (target: Target, draft: ConnectForm, imported: SshConfigHost | null, source: string) => {
    setConnectTarget(target);
    setForm(draft);
    setImportedProfile(imported);
    setFormSource(source);
    setConnectionError(null);
    setHostKey(null);
    setChangedFrom(null);
  };
  const importedDraft = (host: SshConfigHost): ConnectForm => ({ name: host.alias, host: host.host, port: host.port, username: host.username, authMethod: host.authMethod, privateKeyPath: host.privateKeyPath || '', password: '', passphrase: '' });
  const openConnect = (target: Target) => { resetDialog(target, newForm(), null, 'manual'); setConnectOpen(true); };
  const trustHost = (host: string, port: number, key: HostKey) => {
    knownHosts.current = { ...knownHosts.current, [hostId(host, port)]: { fingerprint: key.fingerprint, keyType: key.keyType } };
    try { localStorage.setItem(KNOWN_HOSTS_KEY, JSON.stringify(knownHosts.current)); } catch { /* Trust still applies for this session. */ }
  };
  const establish = async (draft: ConnectForm, imported: SshConfigHost | null, target: Target, fingerprint: string) => {
    const config: SshConfig = { ...draft, name: draft.name.trim() || draft.host.trim(), host: draft.host.trim(), username: draft.username.trim(), port: Number(draft.port), fingerprint };
    const connection = await api.connectSsh(config);
    connectionsRef.current = [...connectionsRef.current.filter(item => item.id !== connection.id), connection];
    setConnections(connectionsRef.current);
    if (imported) {
      importedConnections.current.set(importedHostKey(imported), connection.id);
    } else {
      const profile: Profile = { name: config.name, host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, privateKeyPath: config.privateKeyPath };
      const saved = [...profiles.filter(item => !(item.host === profile.host && item.port === profile.port && item.username === profile.username)), profile];
      setProfiles(saved);
      savedConnections.current.set(profileKey(profile), connection.id);
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(saved)); } catch { /* Connections work even when storage is unavailable. */ }
    }
    setConnectOpen(false);
    resetDialog(target, newForm(), null, 'manual');
    openIn(target, connection);
    notify(`已连接 ${connection.name}`);
  };
  /**
   * Connects straight away when the host key is already trusted (the backend rejects a different key
   * before any credential is sent). Otherwise returns the key the user has to confirm.
   */
  const connectOrInspect = async (draft: ConnectForm, imported: SshConfigHost | null, target: Target) => {
    const host = draft.host.trim();
    const port = Number(draft.port);
    const known = knownHosts.current[hostId(host, port)];
    if (!known) return { key: await api.probeSsh(host, port), previous: null };
    try {
      await establish(draft, imported, target, known.fingerprint);
      return null;
    } catch (error) {
      if (!isHandshakeFailure(error)) throw error;
      const key = await api.probeSsh(host, port);
      if (key.fingerprint === known.fingerprint) throw error;
      return { key, previous: known };
    }
  };
  /** Opens a remembered device with as few prompts as possible: none when its key is trusted and no secret is needed. */
  const quickConnect = async (target: Target, draft: ConnectForm, imported: SshConfigHost | null, source: string) => {
    if (connectionBusy) return;
    resetDialog(target, draft, imported, source);
    if (imported?.warning || draft.authMethod === 'password') { setConnectOpen(true); return; }
    const trusted = !!knownHosts.current[hostId(draft.host, draft.port)];
    if (trusted) notify(`正在连接 ${draft.name || draft.host}…`);
    else setConnectOpen(true);
    setConnectionBusy(true);
    try {
      const pending = await connectOrInspect(draft, imported, target);
      if (pending) { setHostKey(pending.key); setChangedFrom(pending.previous); setConnectOpen(true); }
    } catch (error) {
      setConnectionError(messageOf(error));
      setConnectOpen(true);
    } finally { setConnectionBusy(false); }
  };
  const chooseImportedHost = (target: Target, host: SshConfigHost) => {
    const existing = liveConnection(importedConnections.current.get(importedHostKey(host)));
    if (existing && !host.warning) { setConnectOpen(false); openIn(target, existing); return; }
    void quickConnect(target, importedDraft(host), host, `ssh:${host.alias}`);
  };
  const liveConnection = (id: string | undefined) => connectionsRef.current.find(connection => connection.id === id);
  const chooseProfile = (target: Target, index: number) => {
    const profile = profiles[index];
    if (!profile) return;
    const existing = liveConnection(savedConnections.current.get(profileKey(profile)));
    if (existing) { openIn(target, existing); return; }
    void quickConnect(target, { ...profile, password: '', passphrase: '' }, null, `saved:${index}`);
  };
  const removeProfile = (index: number) => {
    const saved = profiles.filter((_, position) => position !== index);
    setProfiles(saved);
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(saved)); } catch { /* Removal still applies for this session. */ }
  };
  const submitConnection = async (event: FormEvent) => {
    event.preventDefault();
    if (importedProfile?.warning || connectionBusy) return;
    setConnectionError(null);
    setConnectionBusy(true);
    try {
      const pending = await connectOrInspect(form, importedProfile, connectTarget);
      if (pending) { setHostKey(pending.key); setChangedFrom(pending.previous); }
    } catch (error) { setConnectionError(messageOf(error)); }
    finally { setConnectionBusy(false); }
  };
  const confirmConnection = async () => {
    if (!hostKey || importedProfile?.warning || connectionBusy) return;
    setConnectionBusy(true);
    setConnectionError(null);
    trustHost(form.host, Number(form.port), hostKey);
    try { await establish(form, importedProfile, connectTarget, hostKey.fingerprint); }
    catch (error) {
      // The key is trusted now; anything left (e.g. a key passphrase) is fixed in the form.
      setHostKey(null);
      setChangedFrom(null);
      setConnectionError(messageOf(error));
    } finally { setConnectionBusy(false); }
  };
  const disconnect = async (connection: Connection) => {
    if (queue.some(item => ['queued', 'running'].includes(item.status) && [item.sourceConnectionId, item.destinationConnectionId].includes(connection.id))) { notify('这个连接仍有传输任务，请先等待完成或取消任务。', true); return; }
    try {
      await api.disconnect(connection.id);
      connectionsRef.current = connectionsRef.current.filter(item => item.id !== connection.id);
      setConnections(connectionsRef.current);
      const local = localRef.current;
      if (local) eachTab((side, tab) => { if (tab.connectionId === connection.id) void loadDirectory(side, local.id, local.home, false, tab.id); });
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

  const previewKind = preview ? previewFormat(preview.file.name).format : 'text';
  const previewText = preview?.data?.kind === 'text' ? preview.data : null;
  const previewTable = useMemo(() => {
    if (!preview) return null;
    if (preview.table) return preview.table;
    if (!previewText || previewKind !== 'csv') return null;
    return parseDelimited(previewText.content, preview.file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',', previewText.truncated);
  }, [preview, previewText, previewKind]);
  const canToggleSource = !!previewText && (previewKind === 'markdown' || previewKind === 'csv');

  // Title bar: drag only once the pointer moves, so double-clicks always reach the page.
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const titlebarMouseDown = (event: ReactMouseEvent) => {
    dragOrigin.current = event.button === 0 && event.detail === 1 && isWindowChrome(event.target) ? { x: event.clientX, y: event.clientY } : null;
  };
  const titlebarMouseMove = (event: ReactMouseEvent) => {
    const origin = dragOrigin.current;
    if (!origin) return;
    if ((event.buttons & 1) === 0) { dragOrigin.current = null; return; }
    if (Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y) < 4) return;
    dragOrigin.current = null;
    void appWindow.startDragging();
  };
  const titlebarDoubleClick = (event: ReactMouseEvent) => {
    dragOrigin.current = null;
    if (isWindowChrome(event.target)) void appWindow.toggleMaximize();
  };

  const remoteCount = connections.filter(connection => connection.kind === 'ssh').length;
  const refreshAll = () => {
    void reloadSshConfig();
    ([0, 1] as Side[]).forEach(side => {
      const pane = paneAt(side);
      if (pane.connectionId) void loadDirectory(side, pane.connectionId, pane.path, false);
    });
  };
  const panes = [activeOf(sides[0]), activeOf(sides[1])] as const;
  const pickerProps = (side: Side, target: Target) => ({
    otherConnectionId: panes[side === 0 ? 1 : 0].connectionId,
    connections,
    configHosts: sshConfig.hosts,
    configPath: sshConfig.path,
    configLoading,
    configError,
    configWarnings: sshConfig.warnings,
    profiles,
    isHostLive: (host: SshConfigHost) => !!liveConnection(importedConnections.current.get(importedHostKey(host))),
    isProfileLive: (index: number) => !!liveConnection(savedConnections.current.get(profileKey(profiles[index]))),
    onSelectConnection: (next: Connection) => openIn(target, next),
    onSelectHost: (host: SshConfigHost) => chooseImportedHost(target, host),
    onSelectProfile: (index: number) => chooseProfile(target, index),
    onDisconnect: (connection: Connection) => void disconnect(connection),
    onRemoveProfile: removeProfile,
    onReloadConfig: () => void reloadSshConfig(),
    onCreate: () => openConnect(target),
  });

  const contextItems = (): (ContextAction | null)[] => {
    if (!contextMenu) return [];
    const { side } = contextMenu;
    const pane = panes[side];
    const other = panes[side === 0 ? 1 : 0];
    const file = pane.listing?.entries.find(entry => entry.path === contextMenu.selected);
    const ready = !!pane.listing && !pane.loading && !pane.error && !fileBusy;
    const canPaste = ready && !!fileClipboard && connections.some(item => item.id === fileClipboard.connectionId) && (fileClipboard.mode === 'copy' || fileClipboard.connectionId === pane.connectionId);
    if (!file) return [
      { label: '新建文件夹', icon: <FolderPlus size={14} />, shortcut: 'Ctrl+Shift+N', disabled: !ready, onClick: () => openFileDialog(side, 'new') },
      { label: '粘贴', icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', disabled: !canPaste, onClick: () => void pasteFile(side) },
      null,
      { label: '刷新', icon: <RefreshCw size={14} />, shortcut: 'F5', disabled: !pane.connectionId || pane.loading, onClick: () => void loadDirectory(side, pane.connectionId, pane.path, false) },
      { label: '复制当前目录路径', icon: <Link size={14} />, disabled: !ready, onClick: () => void copyPath(side) },
      null,
      { label: '显示隐藏文件', icon: <Eye size={14} />, checked: pane.showHidden, onClick: () => updatePane(side, current => ({ ...current, showHidden: !current.showHidden, selected: null })) },
      { label: '紧凑视图', icon: <List size={14} />, checked: pane.compact, onClick: () => updatePane(side, current => ({ ...current, compact: !current.compact })) },
    ];
    const mutable = ready && !file.isSymlink;
    const connection = connections.find(item => item.id === pane.connectionId);
    return [
      ...(file.isDir ? [
        { label: '打开文件夹', icon: <FolderOpen size={14} />, shortcut: 'Enter', disabled: !mutable, onClick: () => void loadDirectory(side, pane.connectionId, file.path) },
        { label: '在新标签页中打开', icon: <SquareArrowOutUpRight size={14} />, disabled: !mutable || !connection, onClick: () => { if (connection) addTab(side, connection, file.path); } },
      ] : [
        { label: '预览', icon: <Eye size={14} />, shortcut: 'Space', disabled: !mutable, onClick: () => void openPreview(side, file) },
      ]),
      { label: side === 0 ? '传输到右侧' : '传输到左侧', icon: side === 0 ? <ArrowRight size={14} /> : <ArrowLeft size={14} />,
        disabled: !mutable || other.loading || !other.listing || !!other.error || (pane.connectionId === other.connectionId && pane.path === other.path), onClick: () => enqueue(side, file) },
      null,
      { label: '剪切', icon: <Scissors size={14} />, shortcut: 'Ctrl+X', disabled: !mutable, onClick: () => copyFile(side, 'cut') },
      { label: '复制', icon: <Copy size={14} />, shortcut: 'Ctrl+C', disabled: !mutable, onClick: () => copyFile(side, 'copy') },
      ...(file.isDir ? [{ label: '粘贴到此文件夹', icon: <ClipboardPaste size={14} />, disabled: !canPaste || file.isSymlink, onClick: () => void pasteFile(side, file.path) }] : []),
      { label: '复制路径', icon: <Link size={14} />, shortcut: 'Ctrl+Shift+C', disabled: !ready, onClick: () => void copyPath(side) },
      null,
      { label: '重命名', icon: <Pencil size={14} />, shortcut: 'F2', disabled: !mutable, onClick: () => openFileDialog(side, 'rename') },
      { label: '删除', icon: <Trash2 size={14} />, shortcut: 'Delete', danger: true, disabled: !mutable, onClick: () => openFileDialog(side, 'delete') },
      null,
      { label: '属性', icon: <Info size={14} />, shortcut: 'Alt+Enter', disabled: !ready, onClick: () => openFileDialog(side, 'properties') },
    ];
  };

  return (
    <div className={`app ${isDesktop && !maximized ? 'is-framed' : ''}`}>
      <header className="titlebar" onMouseDown={titlebarMouseDown} onMouseMove={titlebarMouseMove} onMouseUp={() => { dragOrigin.current = null; }} onDoubleClick={titlebarDoubleClick}>
        <div className="wordmark" aria-label="Dropping 文件传输"><svg className="wordmark-icon" viewBox="0 0 64 64" aria-hidden="true"><path d="M15.5 25H45.5M39 18.5l6.5 6.5-6.5 6.5M48.5 39H18.5M25 32.5l-6.5 6.5 6.5 6.5" fill="none" stroke="currentColor" strokeWidth="4" /></svg>Dropping</div>
        <div className="titlebar-actions">
          <button className="icon-btn tool-icon" onClick={refreshAll} aria-label="刷新" title="刷新目录与 SSH 配置" disabled={!connections.length}><RefreshCw size={15} /></button>
          <TransferQueue
            items={queue}
            onCancel={item => void cancel(item)}
            onClearFinished={() => {
              setQueue(current => current.filter(item => ['queued', 'running'].includes(item.status)));
              setStatusError(current => current?.transfer ? null : current);
            }}
          />
          <button className="btn btn-primary" onClick={() => openConnect({ side: activeSide, tab: null })}><Plus size={14} />新建连接</button>
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
          const entries = visibleEntries(pane);
          const selected = pane.listing?.entries.find(item => item.path === pane.selected);
          const sideName = side === 0 ? '左侧' : '右侧';
          return (
            <section className={`pane ${activeSide === side ? 'active-pane' : ''}`} key={side} onPointerDown={() => setActiveSide(side)} onFocusCapture={() => setActiveSide(side)} aria-label={`${sideName}工作区`}>
              <div className="pane-head">
                <div className="tabs">
                  {sides[side].tabs.map(tab => {
                    const isActive = tab.id === sides[side].active;
                    const device = connections.find(item => item.id === tab.connectionId);
                    const name = device?.name || '本机';
                    const folder = tab.path ? baseName(tab.path) : '';
                    return (
                      <DevicePicker key={tab.id} label={`${sideName}设备`} current={device} {...pickerProps(side, { side, tab: tab.id })} trigger={({ open, toggle, ref }) => (
                        <div className={`tab ${isActive ? 'is-active' : ''} ${open ? 'is-open' : ''}`}>
                          <button ref={ref} className="tab-main" title={tab.path || name}
                            aria-label={isActive ? `${sideName}设备` : `切换到标签页 ${name}${folder ? ` · ${folder}` : ''}`}
                            aria-current={isActive || undefined} aria-haspopup={isActive ? 'dialog' : undefined} aria-expanded={isActive ? open : undefined}
                            onClick={() => { if (isActive) toggle(); else activateTab(side, tab.id); }}>
                            {device?.kind === 'ssh' ? <Server size={13} className="tab-kind" /> : <Laptop size={13} className="tab-kind" />}
                            <span className="tab-name">{name}</span>
                            {folder && <span className="tab-folder">{folder}</span>}
                            {isActive && <ChevronDown size={11} className="tab-chevron" />}
                          </button>
                          {sides[side].tabs.length > 1 && <button className="tab-close" aria-label={`关闭标签页 ${name}`} title="关闭标签页" onClick={() => closeTab(side, tab.id)}><X size={11} /></button>}
                        </div>
                      )} />
                    );
                  })}
                </div>
                <DevicePicker label={`${sideName}新标签页的设备`} {...pickerProps(side, { side, tab: null })} trigger={({ open, toggle, ref }) => (
                  <button ref={ref} className={`icon-btn tab-add ${open ? 'is-open' : ''}`} aria-label="新建标签页" title="新建标签页" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}><Plus size={14} /></button>
                )} />
              </div>

              <div className="pane-nav">
                <button className="icon-btn" title="返回上一个目录" aria-label="返回上一个目录" disabled={!pane.history.length || pane.loading} onClick={() => {
                  const path = pane.history[pane.history.length - 1];
                  updatePane(side, current => ({ ...current, history: current.history.slice(0, -1) }));
                  void loadDirectory(side, pane.connectionId, path, false);
                }}><ArrowLeft size={14} /></button>
                <button className="icon-btn" title="上一级目录" aria-label="上一级目录" disabled={!pane.listing?.parent || pane.loading} onClick={() => { if (pane.listing?.parent) void loadDirectory(side, pane.connectionId, pane.listing.parent); }}><ArrowUp size={14} /></button>
                <AddressBar
                  label={`${sideName}目录路径`}
                  listDrives={connection?.kind === 'local' ? api.listDrives : undefined}
                  path={pane.error ? pane.draftPath || pane.path : pane.path}
                  disabled={!connection}
                  onNavigate={path => { if (pane.connectionId) void loadDirectory(side, pane.connectionId, path); }}
                />
                <button className="icon-btn" title="刷新目录" aria-label="刷新目录" disabled={!pane.connectionId || pane.loading} onClick={() => void loadDirectory(side, pane.connectionId, pane.path, false)}><RefreshCw size={13} className={pane.loading ? 'spin' : ''} /></button>
                <FileToolbar ready={!!pane.listing && !pane.loading && !pane.error} selected={!!selected && !selected.isSymlink} busy={fileBusy}
                  canPaste={!!fileClipboard && connections.some(item => item.id === fileClipboard.connectionId) && (fileClipboard.mode === 'copy' || fileClipboard.connectionId === pane.connectionId)}
                  clipboardName={fileClipboard?.file.name} showHidden={pane.showHidden} compact={pane.compact} sort={pane.sort} ascending={pane.ascending}
                  onNewFolder={() => openFileDialog(side, 'new')} onCut={() => copyFile(side, 'cut')} onCopy={() => copyFile(side, 'copy')}
                  onPaste={() => void pasteFile(side)} onRename={() => openFileDialog(side, 'rename')} onDelete={() => openFileDialog(side, 'delete')}
                  onCopyPath={() => void copyPath(side)} onProperties={() => openFileDialog(side, 'properties')}
                  onHome={() => { if (connection) void loadDirectory(side, pane.connectionId, connection.home); }}
                  onHidden={() => updatePane(side, current => ({ ...current, showHidden: !current.showHidden, selected: null }))}
                  onCompact={() => updatePane(side, current => ({ ...current, compact: !current.compact }))}
                  onSort={(sort, ascending) => updatePane(side, current => ({ ...current, sort, ascending }))}
                />
                <label className="filter-field">
                  <Search size={12} />
                  <input placeholder="筛选" aria-label={`筛选${sideName}文件`} value={pane.search} onChange={event => updatePane(side, current => ({ ...current, search: event.target.value, selected: null }))} />
                  {pane.search && <button className="filter-clear" aria-label="清除筛选" onClick={() => updatePane(side, current => ({ ...current, search: '' }))}><X size={11} /></button>}
                </label>
              </div>

              <div ref={element => { fileLists.current[side] = element; }} className={`file-list ${pane.loading ? 'is-loading' : ''} ${pane.compact ? 'is-compact' : ''}`} tabIndex={0} aria-label={`${sideName}文件列表，空格预览，回车打开或传输`}
                onContextMenu={event => { event.preventDefault(); openContextMenu(side, null, event.clientX, event.clientY); }}
                onKeyDown={event => {
                  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                  event.preventDefault(); event.stopPropagation();
                  const row = event.currentTarget.querySelector('[aria-selected="true"]') || event.currentTarget;
                  const rect = row.getBoundingClientRect();
                  openContextMenu(side, pane.selected === PARENT_ROW ? null : pane.selected, rect.left + 24, rect.top + Math.min(rect.height, 28));
                }}>
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
                    {!pane.error && pane.listing?.parent && (
                      <tr className={`parent-row ${pane.selected === PARENT_ROW ? 'selected-row' : ''}`} aria-selected={pane.selected === PARENT_ROW} title="返回上一级"
                        onClick={() => updatePane(side, current => ({ ...current, selected: PARENT_ROW }))}
                        onDoubleClick={() => { if (!pane.loading && pane.listing?.parent) void loadDirectory(side, pane.connectionId, pane.listing.parent); }}>
                        <td><span className="file-name"><CornerLeftUp size={16} className="file-icon parent-icon" /><span>..</span></span></td>
                        <td className="col-size" />
                        <td className="col-modified" />
                      </tr>
                    )}
                    {!pane.error && entries.map(entry => (
                      <tr key={entry.path} className={`${pane.selected === entry.path ? 'selected-row' : ''} ${fileClipboard?.mode === 'cut' && fileClipboard.connectionId === pane.connectionId && fileClipboard.file.path === entry.path ? 'cut-row' : ''}`} aria-selected={pane.selected === entry.path}
                        onClick={() => updatePane(side, current => ({ ...current, selected: entry.path }))}
                        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openContextMenu(side, entry.path, event.clientX, event.clientY); }}
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
                  <div className={`list-state ${pane.listing?.parent ? 'below-parent' : ''}`}>
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
                <button className="btn btn-primary btn-drop" title={side === 0 ? '传到右侧' : '传到左侧'} disabled={!selected || pane.loading || !!pane.error || other.loading || !other.listing || !!other.error} onClick={() => enqueue(side)}>
                  {side === 1 && <ArrowLeft size={13} />}Drop{side === 0 && <ArrowRight size={13} />}
                </button>
              </div>
            </section>
          );
        })}
      </main>

      <footer className="statusbar" aria-live="polite">
        {statusError
          ? <button className="status-item status-error" title={`${statusError.text}（点击清除）`} onClick={() => setStatusError(null)}><span className="dot is-error" /><span className="truncate">{statusError.text}</span></button>
          : <span className="status-item"><span className={`dot ${isDesktop ? 'is-ok' : 'off'}`} />{isDesktop ? '就绪' : '浏览器预览'}</span>}
        <span className="status-item">{remoteCount} 个远程连接</span>
        <span className="status-item status-version muted">v{version}</span>
      </footer>

      {notification && (
        <div className={`toast ${notification.error ? 'toast-error' : ''}`} role={notification.error ? 'alert' : 'status'}>
          {notification.error ? <CircleAlert size={14} /> : <Check size={14} />}
          <span>{notification.text}</span>
          <button className="icon-btn" onClick={() => setNotification(null)} aria-label="关闭提示"><X size={13} /></button>
        </div>
      )}

      {contextMenu && <ContextMenu key={contextMenu.id} x={contextMenu.x} y={contextMenu.y} label={contextMenu.selected ? '项目右键菜单' : '工作区右键菜单'} items={contextItems()} onClose={closeContextMenu} />}

      {fileDialog && (
        <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeFileDialog(); }}>
          <section ref={fileDialogRef} className="dialog file-dialog" role="dialog" aria-modal="true" aria-labelledby="file-dialog-title">
            <div className="dialog-head">
              <div><h2 id="file-dialog-title">{fileDialog.kind === 'new' ? '新建文件夹' : fileDialog.kind === 'rename' ? '重命名' : fileDialog.kind === 'delete' ? '删除确认' : '属性'}</h2>
                <p className="truncate" title={fileDialog.directory}>{connections.find(item => item.id === fileDialog.connectionId)?.name} · {fileDialog.directory}</p></div>
              <button className="icon-btn" aria-label="关闭文件窗口" disabled={fileBusy} onClick={closeFileDialog}><X size={15} /></button>
            </div>
            {fileDialog.kind === 'properties' && fileDialog.file ? (
              <div className="dialog-body">
                <dl className="file-properties">
                  <dt>名称</dt><dd>{fileDialog.file.name}</dd>
                  <dt>类型</dt><dd>{fileDialog.file.isSymlink ? '符号链接' : fileDialog.file.isDir ? '文件夹' : '文件'}</dd>
                  <dt>大小</dt><dd>{fileDialog.file.isDir ? '—' : `${formatSize(fileDialog.file.size)} (${fileDialog.file.size.toLocaleString()} 字节)`}</dd>
                  <dt>修改时间</dt><dd>{formatDate(fileDialog.file.modified) || '—'}</dd>
                  <dt>路径</dt><dd><code>{fileDialog.file.path}</code></dd>
                </dl>
                <div className="dialog-foot"><button className="btn" onClick={() => {
                  void navigator.clipboard.writeText(fileDialog.file!.path).then(() => notify('路径已复制')).catch(error => notify(`复制路径失败：${messageOf(error)}`, true));
                }}>复制路径</button><button className="btn btn-primary" onClick={closeFileDialog}>关闭</button></div>
              </div>
            ) : (
              <form className="dialog-body" onSubmit={event => void submitFileDialog(event)}>
                {fileDialog.kind === 'delete' ? <div className="delete-warning"><CircleAlert size={20} /><div><p>永久删除「{fileDialog.file?.name}」？</p><span className="hint">{fileDialog.file?.isDir ? '文件夹及其全部内容将被删除。' : ''}此操作不进入回收站，无法撤销。</span></div></div>
                  : <label className="field"><span>{fileDialog.kind === 'new' ? '文件夹名称' : '新名称'}</span><input required disabled={fileBusy} value={fileName} onChange={event => setFileName(event.target.value)} spellCheck={false} /></label>}
                {fileError && <div className="form-error" role="alert"><CircleAlert size={13} /><span>{fileError}</span></div>}
                <div className="dialog-foot"><button type="button" className="btn" disabled={fileBusy} onClick={closeFileDialog}>取消</button>
                  <button type="submit" className={`btn ${fileDialog.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={fileBusy}>
                    {fileBusy && <LoaderCircle size={13} className="spin" />}{fileBusy ? '处理中…' : fileDialog.kind === 'delete' ? '永久删除' : fileDialog.kind === 'new' ? '创建' : '保存'}
                  </button></div>
              </form>
            )}
          </section>
        </div>
      )}

      {connectOpen && (
        <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !connectionBusy) setConnectOpen(false); }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
            <div className="dialog-head">
              <div>
                <h2 id="connection-title">{hostKey ? '确认服务器身份' : '连接远程设备'}</h2>
                <p>{changedFrom ? '服务器的主机指纹已变化，请先核实。' : hostKey ? '首次连接此服务器，请核对 SSH 主机指纹。确认后会记住，下次不再询问。' : '通过 SFTP 访问另一台电脑的文件。'}</p>
              </div>
              <button className="icon-btn" onClick={() => setConnectOpen(false)} disabled={connectionBusy} aria-label="关闭连接窗口"><X size={15} /></button>
            </div>
            {!hostKey ? (
              <form onSubmit={event => void submitConnection(event)} className="dialog-body">
                <fieldset disabled={connectionBusy}>
                  <label className="field"><span>连接来源</span><select value={formSource} onChange={event => {
                    const value = event.target.value;
                    const host = value.startsWith('ssh:') ? sshConfig.hosts.find(item => item.alias === value.slice(4)) : undefined;
                    const profile = value.startsWith('saved:') ? profiles[Number(value.slice(6))] : undefined;
                    if (host) resetDialog(connectTarget, importedDraft(host), host, value);
                    else resetDialog(connectTarget, profile ? { ...profile, password: '', passphrase: '' } : newForm(), null, profile ? value : 'manual');
                  }}>
                    <option value="manual">手动填写连接信息</option>
                    {sshConfig.hosts.length > 0 && <optgroup label="SSH 配置">{sshConfig.hosts.map(host => <option key={host.alias} value={`ssh:${host.alias}`}>{host.alias} · {host.username}@{host.host}{host.warning ? ' · 需检查配置' : ''}</option>)}</optgroup>}
                    {profiles.length > 0 && <optgroup label="已保存的连接">{profiles.map((profile, index) => <option key={`${profile.host}:${profile.port}:${profile.username}`} value={`saved:${index}`}>{profile.name || profile.host} · {profile.username}@{profile.host}</option>)}</optgroup>}
                  </select></label>
                  {importedProfile && <p className="hint" title={sshConfig.path}>参数来自 {sshConfig.path}，如需修改请切换为手动填写。</p>}
                  {importedProfile?.warning && <div className="form-error" role="alert"><CircleAlert size={13} /><span>此配置暂不能直接连接：{importedProfile.warning}</span></div>}
                  <label className="field"><span>连接名称 <em>可选</em></span><input placeholder="例如：研究服务器" autoFocus={formSource === 'manual'} readOnly={!!importedProfile} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
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
                  </> : <label className="field"><span>密码</span><input type="password" required autoFocus={formSource !== 'manual'} autoComplete="current-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label>}
                  {connectionError && <div className="form-error" role="alert"><CircleAlert size={13} /><span>{connectionError}</span></div>}
                  <div className="dialog-foot">
                    <span className="hint">密码和口令仅用于本次连接，不会保存。</span>
                    <button type="button" className="btn" onClick={() => setConnectOpen(false)} disabled={connectionBusy}>取消</button>
                    <button className="btn btn-primary" type="submit" disabled={connectionBusy || !!importedProfile?.warning}>{connectionBusy && <LoaderCircle size={13} className="spin" />}{connectionBusy ? '正在连接…' : '继续连接'}</button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <div className="dialog-body">
                {changedFrom && <div className="form-error" role="alert"><CircleAlert size={13} /><span>主机指纹与上次信任的不一致。服务器可能更换了密钥，也可能存在中间人攻击；请向管理员核实后再继续。</span></div>}
                <dl className="fingerprint">
                  <dt>服务器</dt><dd><code>{form.host}:{form.port}</code></dd>
                  {changedFrom && <><dt>原指纹</dt><dd><code>{changedFrom.fingerprint}</code></dd></>}
                  <dt>{hostKey.keyType}</dt><dd><code>{hostKey.fingerprint}</code></dd>
                </dl>
                <p className="hint">请与服务器管理员提供的指纹核对，一致时再信任此连接。可在服务器上运行 <code>ssh-keygen -lf</code> 查看主机公钥指纹。</p>
                {connectionError && <div className="form-error" role="alert"><CircleAlert size={13} /><span>{connectionError}</span></div>}
                <div className="dialog-foot">
                  <button className="btn" onClick={() => { setHostKey(null); setChangedFrom(null); setConnectionError(null); }} disabled={connectionBusy}>返回修改</button>
                  <button className="btn btn-primary" onClick={() => void confirmConnection()} disabled={connectionBusy}>{connectionBusy && <LoaderCircle size={13} className="spin" />}{connectionBusy ? '正在连接…' : changedFrom ? '信任新指纹并连接' : '信任并连接'}</button>
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
                <div className="preview-title">
                  <h2 id="preview-title">{preview.file.name}</h2>
                  {canToggleSource && (
                    <button className={`icon-btn icon-btn-sm toggle-btn ${previewSource ? 'is-on' : ''}`} aria-label="源码" aria-pressed={previewSource} title={previewSource ? '显示渲染效果' : '显示源码'} onClick={() => setPreviewSource(value => !value)}>
                      <CodeXml size={13} />
                    </button>
                  )}
                </div>
                <p>{preview.connectionName} · {formatSize(preview.file.size)}{previewTable && !previewSource && ` · ${previewTable.columns.length} 列`}</p>
              </div>
              <button className="icon-btn" aria-label="关闭预览" onClick={closePreview}><X size={15} /></button>
            </div>
            <div className={`preview-content ${preview.data?.kind === 'image' ? 'is-image' : ''}`}>
              {preview.loading ? <div className="list-state"><span className="muted">加载中…</span></div>
                : preview.error ? <div className="list-state"><strong>无法预览此文件</strong><p>{preview.error}</p></div>
                : previewTable && !previewSource ? <DataTable table={previewTable} />
                : preview.data?.kind === 'text' ? <PreviewContent name={preview.file.name} content={preview.data.content} showSource={previewSource} />
                : preview.data?.kind === 'image' ? <img src={preview.data.content.startsWith('data:') ? preview.data.content : `data:${preview.data.mime};base64,${preview.data.content}`} alt={preview.file.name} />
                : <div className="list-state"><strong>不支持预览此类型</strong><p>{preview.data?.content || '支持常见文本、代码文件和图片。文件仍可正常传输。'}</p></div>}
            </div>
            <div className="preview-foot">
              <code title={preview.file.path}>{preview.file.path}</code>
              {previewTable && !previewSource
                ? <span>{previewText?.truncated ? `文件较大，显示开头 ${previewTable.shownRows.toLocaleString()} 行` : previewTable.shownRows < previewTable.totalRows ? `显示前 ${previewTable.shownRows.toLocaleString()} 行，共 ${previewTable.totalRows.toLocaleString()} 行` : `共 ${previewTable.totalRows.toLocaleString()} 行`}</span>
                : preview.data?.kind === 'text' && preview.data.truncated && <span>文件较大，仅显示开头部分</span>}
              <span>只读</span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
