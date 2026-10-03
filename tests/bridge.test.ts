import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

beforeEach(() => vi.resetModules());

describe('desktop bridge', () => {
  it('reads SSH profiles through the desktop command without passing credentials', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue({ path: 'C:\\Users\\test\\.ssh\\config', hosts: [], warnings: [] });
    const { api } = await import('../src/bridge');
    await api.getSshConfigHosts();
    expect(tauri.invoke).toHaveBeenCalledWith('get_ssh_config_hosts', undefined);
  });
  it('forwards transfer paths and endpoint identities without rewriting', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue({ targetPath: '/产物/model.bin', bytes: 20, files: 1 });
    const { api } = await import('../src/bridge');
    const args = { id: 'job-1', sourceConnectionId: 'ssh-a', destinationConnectionId: 'ssh-b', sourcePath: '/研究/model.bin', destinationDirectory: '/产物' };
    await api.startTransfer(args);
    expect(tauri.invoke).toHaveBeenCalledWith('start_transfer', args);
  });

  it('passes only the event payload to subscribers and returns cleanup', async () => {
    tauri.isTauri.mockReturnValue(true);
    const cleanup = vi.fn();
    tauri.listen.mockImplementation(async (_name, callback) => {
      callback({ payload: { id: 'job-1', bytesTransferred: 42 } });
      return cleanup;
    });
    const { onTransferProgress } = await import('../src/bridge');
    const callback = vi.fn();
    const stop = await onTransferProgress(callback);
    expect(callback).toHaveBeenCalledWith({ id: 'job-1', bytesTransferred: 42 });
    stop();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not claim filesystem or SSH operations worked in browser preview', async () => {
    tauri.isTauri.mockReturnValue(false);
    const { api, isDesktop } = await import('../src/bridge');
    expect(isDesktop).toBe(false);
    expect((await api.getLocalInfo()).kind).toBe('local');
    expect((await api.getSshConfigHosts()).hosts).toEqual([]);
    await expect(api.listDirectory('local', '/')).rejects.toThrow('桌面客户端');
    await expect(api.probeSsh('example.com', 22)).rejects.toThrow('桌面客户端');
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
