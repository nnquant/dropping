import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryListing, SshConfigHosts, TransferResult } from '../src/types';

const mocked = vi.hoisted(() => ({
  getLocalInfo: vi.fn(), listDirectory: vi.fn(), previewFile: vi.fn(), startTransfer: vi.fn(),
  cancelTransfer: vi.fn(), disconnect: vi.fn(), probeSsh: vi.fn(), connectSsh: vi.fn(),
  onTransferProgress: vi.fn(), getSshConfigHosts: vi.fn(),
}));
vi.mock('../src/bridge', () => ({ api: mocked, isDesktop: true, onTransferProgress: mocked.onTransferProgress }));
import App from '../src/App';

const source = 'C:\\fixture\\source';
const destination = 'C:\\fixture\\destination';
const importedConfig: SshConfigHosts = {
  path: 'C:\\Users\\research\\.ssh\\config', warnings: [],
  hosts: [{ alias: 'quant-server', host: '10.20.30.40', port: 2222, username: 'research', authMethod: 'key', privateKeyPath: 'C:\\Users\\research\\.ssh\\quant_ed25519', warning: null }],
};
const listing = (path: string): DirectoryListing => ({
  path, parent: 'C:\\fixture',
  entries: path === destination ? [] : [
    { name: 'report.txt', path: `${path}\\report.txt`, isDir: false, isSymlink: false, size: 12, modified: 1791000000000 },
    { name: 'model.bin', path: `${path}\\model.bin`, isDir: false, isSymlink: false, size: 24, modified: 1791000000000 },
    { name: 'outputs', path: `${path}\\outputs`, isDir: true, isSymlink: false, size: 0, modified: null },
  ],
});

beforeEach(() => {
  localStorage.clear();
  mocked.getLocalInfo.mockResolvedValue({ id: 'local', kind: 'local', name: '此电脑', home: source });
  mocked.getSshConfigHosts.mockResolvedValue({ path: importedConfig.path, hosts: [], warnings: [] });
  mocked.listDirectory.mockImplementation(async (_id: string, path: string) => listing(path));
  mocked.onTransferProgress.mockResolvedValue(() => {});
  mocked.previewFile.mockResolvedValue({ kind: 'text', content: '研究产物预览', mime: 'text/plain', size: 12, truncated: false });
  mocked.cancelTransfer.mockResolvedValue(undefined);
});

describe('local SSH configuration', () => {
  it('automatically lists config aliases in both panes without contacting servers', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    await setup();
    for (const name of ['左侧设备', '右侧设备']) {
      const selector = within(screen.getByRole('combobox', { name }));
      expect(selector.getByRole('group', { name: 'SSH 配置' })).toBeTruthy();
      expect(selector.getByRole('option', { name: 'quant-server' })).toBeTruthy();
    }
    expect(screen.getByText(importedConfig.path)).toBeTruthy();
    expect(screen.getByText('1 台设备')).toBeTruthy();
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    expect(mocked.connectSsh).not.toHaveBeenCalled();
  });

  it('prefills alias, effective host, port, user and Windows key path before explicit probing', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    const user = await setup();
    await user.selectOptions(screen.getByLabelText('右侧设备'), 'ssh:quant-server');
    expect((screen.getByLabelText(/连接名称/) as HTMLInputElement).value).toBe('quant-server');
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).value).toBe('10.20.30.40');
    expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('2222');
    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('research');
    expect((screen.getByLabelText('本机私钥路径') as HTMLInputElement).value).toBe(importedConfig.hosts[0].privateKeyPath);
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(true);
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    expect(await screen.findByText('SHA256:imported-key')).toBeTruthy();
    expect(mocked.probeSsh).toHaveBeenCalledWith('10.20.30.40', 2222);
    expect(mocked.connectSsh).not.toHaveBeenCalled();
  });

  it('keeps local browsing and manual connections usable when the config is missing', async () => {
    const user = await setup();
    expect(screen.getByText('0 台设备')).toBeTruthy();
    expect(screen.queryByText('读取失败，可手动连接')).toBeNull();
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    expect((screen.getByLabelText('连接来源') as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(false);
    expect(screen.getAllByText('report.txt')).toHaveLength(2);
  });

  it('shows a nonfatal read error without blocking local files or manual entry', async () => {
    mocked.getSshConfigHosts.mockRejectedValue(new Error('无法读取 SSH 配置：Access denied'));
    const user = await setup();
    expect(await screen.findByText('读取失败，可手动连接')).toBeTruthy();
    expect(screen.getAllByText('report.txt')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    expect(screen.getByLabelText('主机地址')).toBeTruthy();
    expect(mocked.probeSsh).not.toHaveBeenCalled();
  });

  it('blocks unsupported routing, including direct submit, but allows switching to manual entry', async () => {
    mocked.getSshConfigHosts.mockResolvedValue({ ...importedConfig, hosts: [{ ...importedConfig.hosts[0], warning: 'ProxyJump 暂不支持，请保留跳板机路由。' }], warnings: ['quant-server 使用 ProxyJump'] });
    const user = await setup();
    await user.selectOptions(screen.getByLabelText('左侧设备'), 'ssh:quant-server');
    expect(screen.getByRole('alert').textContent).toContain('ProxyJump');
    expect((screen.getByRole('button', { name: '继续连接' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText('主机地址').closest('form')!);
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('连接来源'), 'manual');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: '继续连接' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(false);
  });

  it('keeps imported and saved profiles in distinct groups and clears imported restrictions for saved profiles', async () => {
    const manual = { name: 'manual-server', host: 'manual.example.com', port: 22, username: 'operator', authMethod: 'password' };
    localStorage.setItem('dropping.connections.v1', JSON.stringify([manual]));
    mocked.getSshConfigHosts.mockResolvedValue({ ...importedConfig, hosts: [{ ...importedConfig.hosts[0], warning: 'ProxyCommand 暂不支持' }] });
    const user = await setup();
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    const sources = within(screen.getByLabelText('连接来源'));
    expect(sources.getByRole('group', { name: 'SSH 配置' })).toBeTruthy();
    expect(sources.getByRole('group', { name: '已保存的连接' })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('连接来源'), 'ssh:quant-server');
    expect(screen.getByRole('alert').textContent).toContain('ProxyCommand');
    await user.selectOptions(screen.getByLabelText('连接来源'), 'saved:0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).value).toBe('manual.example.com');
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(false);
    expect((screen.getByRole('button', { name: '继续连接' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reuses an imported live connection across panes without saving an imported profile', async () => {
    const originalProfiles = JSON.stringify([{ name: 'manual-server', host: 'manual.example.com', port: 22, username: 'operator', authMethod: 'password' }]);
    localStorage.setItem('dropping.connections.v1', originalProfiles);
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await user.selectOptions(screen.getByLabelText('右侧设备'), 'ssh:quant-server');
    await user.type(screen.getByLabelText(/私钥口令/), 'session-only-passphrase');
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    await screen.findByText('SHA256:imported-key');
    await user.click(screen.getByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.connectSsh.mock.calls[0][0]).toMatchObject({ name: 'quant-server', host: '10.20.30.40', port: 2222, username: 'research', privateKeyPath: importedConfig.hosts[0].privateKeyPath, passphrase: 'session-only-passphrase' });
    expect(localStorage.getItem('dropping.connections.v1')).toBe(originalProfiles);
    await user.selectOptions(screen.getByLabelText('左侧设备'), 'ssh:quant-server');
    await waitFor(() => expect((screen.getByLabelText('左侧设备') as HTMLSelectElement).value).toBe('ssh-imported'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocked.probeSsh).toHaveBeenCalledOnce();
    expect(mocked.connectSsh).toHaveBeenCalledOnce();
  });

  it('reloads changed SSH config without disconnecting sessions or reusing a stale endpoint', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await user.selectOptions(screen.getByLabelText('右侧设备'), 'ssh:quant-server');
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    await screen.findByText('SHA256:imported-key');
    await user.click(screen.getByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    mocked.getSshConfigHosts.mockResolvedValue({ ...importedConfig, hosts: [{ ...importedConfig.hosts[0], host: '10.20.30.50' }] });
    const callsBeforeReload = mocked.getSshConfigHosts.mock.calls.length;
    await user.click(screen.getByRole('button', { name: '重新读取 SSH 配置' }));
    await waitFor(() => expect(mocked.getSshConfigHosts).toHaveBeenCalledTimes(callsBeforeReload + 1));
    expect((screen.getByLabelText('右侧设备') as HTMLSelectElement).value).toBe('ssh-imported');
    expect(mocked.disconnect).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText('左侧设备'), 'ssh:quant-server');
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).value).toBe('10.20.30.50');
    expect(mocked.connectSsh).toHaveBeenCalledOnce();
  });
});
afterEach(cleanup);

async function setup() {
  const user = userEvent.setup();
  render(<StrictMode><App /></StrictMode>);
  await screen.findAllByText('report.txt');
  return user;
}
async function changeRightPath() {
  fireEvent.change(screen.getByLabelText('右侧目录路径'), { target: { value: destination } });
  fireEvent.submit(screen.getByLabelText('右侧目录路径').closest('form')!);
  await waitFor(() => expect(screen.getByText('这个目录很干净')).toBeTruthy());
}

describe('workspace behavior', () => {
  it('previews the selected file with Space but does not hijack typing', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByText('report.txt'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(await screen.findByText('研究产物预览')).toBeTruthy();
    expect(mocked.previewFile).toHaveBeenCalledWith('local', `${source}\\report.txt`);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    mocked.previewFile.mockClear();
    fireEvent.keyDown(screen.getByLabelText('筛选左侧文件'), { key: ' ', code: 'Space', bubbles: true });
    expect(mocked.previewFile).not.toHaveBeenCalled();
  });

  it('uses focused right pane for keyboard selection and preview', async () => {
    await setup();
    const list = screen.getByLabelText('右侧文件列表，空格预览，回车打开或传输');
    fireEvent.focus(list);
    fireEvent.keyDown(list, { key: 'ArrowDown', bubbles: true });
    fireEvent.keyDown(list, { key: 'ArrowDown', bubbles: true });
    fireEvent.keyDown(list, { key: ' ', code: 'Space', bubbles: true });
    expect(await screen.findByText('研究产物预览')).toBeTruthy();
    const right = screen.getByRole('region', { name: '右侧工作区' });
    expect(right.className).toContain('active-pane');
  });

  it('navigates a folder without transferring it', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.dblClick(left.getByText('outputs'));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenCalledWith('local', `${source}\\outputs`));
    expect(mocked.startTransfer).not.toHaveBeenCalled();
  });

  it('runs only one transfer at a time and cancels queued work without invoking it', async () => {
    const user = await setup();
    await changeRightPath();
    let finish!: (result: TransferResult) => void;
    mocked.startTransfer.mockImplementation(() => new Promise<TransferResult>(resolve => { finish = resolve; }));
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.dblClick(left.getByText('report.txt'));
    await user.dblClick(left.getByText('model.bin'));
    expect(mocked.startTransfer).toHaveBeenCalledTimes(1);
    expect(screen.getByText('排队中')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消 model.bin' }));
    expect(mocked.cancelTransfer).not.toHaveBeenCalled();
    await act(async () => finish({ targetPath: `${destination}\\report.txt`, bytes: 12, files: 1 }));
    expect(await screen.findByText('已完成')).toBeTruthy();
    expect(screen.getByText('已取消')).toBeTruthy();
    expect(mocked.startTransfer).toHaveBeenCalledTimes(1);
    expect(mocked.startTransfer.mock.calls[0][0]).toMatchObject({ sourcePath: `${source}\\report.txt`, destinationDirectory: destination });
  });

  it('does not authenticate before fingerprint confirmation or persist secrets', async () => {
    const user = await setup();
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:test-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-test', name: '研究机', kind: 'ssh', host: '127.0.0.1', username: 'research', home: '/home/research' });
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    await user.type(screen.getByLabelText(/连接名称/), '研究机');
    await user.type(screen.getByLabelText('主机地址'), '127.0.0.1');
    await user.type(screen.getByLabelText('用户名'), 'research');
    await user.click(screen.getByRole('button', { name: '密码', exact: true }));
    await user.type(screen.getByLabelText('密码', { exact: true }), 'fixture-secret');
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    expect(await screen.findByText('SHA256:test-key')).toBeTruthy();
    expect(mocked.connectSsh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(mocked.connectSsh).toHaveBeenCalledOnce());
    expect(mocked.connectSsh.mock.calls[0][0]).toMatchObject({ fingerprint: 'SHA256:test-key', password: 'fixture-secret' });
    const saved = localStorage.getItem('dropping.connections.v1')!;
    expect(saved).toContain('127.0.0.1');
    expect(saved).not.toContain('fixture-secret');
    expect(JSON.parse(saved)[0]).not.toHaveProperty('password');
    expect(JSON.parse(saved)[0]).not.toHaveProperty('passphrase');
  });
});
