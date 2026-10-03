import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Connection, DirectoryListing, HostKey, Preview, SshConfig, SshConfigHosts, TransferArgs, TransferProgress, TransferResult } from './types';

export const isDesktop = isTauri();

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) throw new Error('请在 Dropping 桌面客户端中使用此功能。当前为界面预览。');
  return invoke<T>(name, args);
}

export const api = {
  getLocalInfo: () => isDesktop
    ? command<Connection>('get_local_info')
    : Promise.resolve<Connection>({ id: 'local', name: '此电脑', kind: 'local', home: '' }),
  listDrives: () => isDesktop ? command<string[]>('list_drives') : Promise.resolve<string[]>([]),
  getSshConfigHosts: () => isDesktop
    ? command<SshConfigHosts>('get_ssh_config_hosts')
    : Promise.resolve<SshConfigHosts>({ path: '', hosts: [], warnings: [] }),
  probeSsh: (host: string, port: number) => command<HostKey>('probe_ssh', { host, port }),
  connectSsh: (config: SshConfig) => command<Connection>('connect_ssh', { config }),
  disconnect: (connectionId: string) => command<void>('disconnect', { connectionId }),
  listDirectory: (connectionId: string, path: string) => command<DirectoryListing>('list_directory', { connectionId, path }),
  previewFile: (connectionId: string, path: string) => command<Preview>('preview_file', { connectionId, path }),
  readFileRange: (connectionId: string, path: string, offset: number, length: number) => command<ArrayBuffer>('read_file_range', { connectionId, path, offset, length }),
  startTransfer: (args: TransferArgs) => command<TransferResult>('start_transfer', { ...args }),
  cancelTransfer: (id: string) => command<void>('cancel_transfer', { id }),
};

export async function onTransferProgress(callback: (event: TransferProgress) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen<TransferProgress>('transfer-progress', event => callback(event.payload));
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export const appWindow = {
  minimize: async () => { if (isDesktop) await (await currentWindow()).minimize(); },
  toggleMaximize: async () => { if (isDesktop) await (await currentWindow()).toggleMaximize(); },
  close: async () => { if (isDesktop) await (await currentWindow()).close(); },
  startDragging: async () => { if (isDesktop) await (await currentWindow()).startDragging(); },
  isMaximized: async () => isDesktop ? (await currentWindow()).isMaximized() : false,
  onResized: async (callback: () => void): Promise<() => void> => isDesktop ? (await currentWindow()).onResized(callback) : () => {},
};
