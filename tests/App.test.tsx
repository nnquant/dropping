import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryListing, SshConfigHosts, TransferResult } from '../src/types';

const mocked = vi.hoisted(() => ({
  getLocalInfo: vi.fn(), listDirectory: vi.fn(), previewFile: vi.fn(), startTransfer: vi.fn(),
  cancelTransfer: vi.fn(), disconnect: vi.fn(), probeSsh: vi.fn(), connectSsh: vi.fn(),
  onTransferProgress: vi.fn(), getSshConfigHosts: vi.fn(), readFileRange: vi.fn(), listDrives: vi.fn(),
}));
const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}), close: vi.fn(async () => {}), startDragging: vi.fn(async () => {}),
  isMaximized: vi.fn(async () => false), onResized: vi.fn(async () => () => {}),
}));
vi.mock('../src/bridge', () => ({ api: mocked, appWindow, isDesktop: true, onTransferProgress: mocked.onTransferProgress }));
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
  mocked.listDrives.mockResolvedValue(['C:\\', 'D:\\']);
});

describe('local SSH configuration', () => {
  it('automatically lists config aliases in both panes without contacting servers', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    const user = await setup();
    for (const name of ['左侧设备', '右侧设备']) {
      await user.click(screen.getByRole('button', { name }));
      const panel = within(screen.getByRole('dialog', { name: `选择${name}` }));
      const config = within(panel.getByRole('group', { name: 'SSH 配置' }));
      expect(config.getByRole('button', { name: /^quant-server/ })).toBeTruthy();
      expect(config.getByText(importedConfig.path)).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
    }
    expect(screen.queryByText(importedConfig.path)).toBeNull();
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    expect(mocked.connectSsh).not.toHaveBeenCalled();
  });

  it('jumps straight to the fingerprint of a first-time key host and keeps its config read-only', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    expect(await screen.findByText('SHA256:imported-key')).toBeTruthy();
    expect(screen.getByText('10.20.30.40:2222')).toBeTruthy();
    expect(mocked.probeSsh).toHaveBeenCalledWith('10.20.30.40', 2222);
    expect(mocked.connectSsh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回修改' }));
    expect((screen.getByLabelText(/连接名称/) as HTMLInputElement).value).toBe('quant-server');
    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('research');
    expect((screen.getByLabelText('本机私钥路径') as HTMLInputElement).value).toBe(importedConfig.hosts[0].privateKeyPath);
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    await user.click(await screen.findByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.connectSsh.mock.calls[0][0]).toMatchObject({ name: 'quant-server', host: '10.20.30.40', port: 2222, username: 'research', privateKeyPath: importedConfig.hosts[0].privateKeyPath, fingerprint: 'SHA256:imported-key' });
  });

  it('keeps local browsing and manual connections usable when the config is missing', async () => {
    const user = await setup();
    await user.click(screen.getByRole('button', { name: '左侧设备' }));
    expect(within(screen.getByRole('group', { name: 'SSH 配置' })).getByText('配置中没有可用的主机')).toBeTruthy();
    expect(screen.queryByText('读取失败，可手动连接')).toBeNull();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    expect((screen.getByLabelText('连接来源') as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).readOnly).toBe(false);
    expect(screen.getAllByText('report.txt')).toHaveLength(2);
  });

  it('shows a nonfatal read error without blocking local files or manual entry', async () => {
    mocked.getSshConfigHosts.mockRejectedValue(new Error('无法读取 SSH 配置：Access denied'));
    const user = await setup();
    await user.click(screen.getByRole('button', { name: '左侧设备' }));
    expect(await screen.findByText('读取失败，可手动连接')).toBeTruthy();
    expect(screen.getByText('无法读取 SSH 配置：Access denied')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.getAllByText('report.txt')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '新建连接' }));
    expect(screen.getByLabelText('主机地址')).toBeTruthy();
    expect(mocked.probeSsh).not.toHaveBeenCalled();
  });

  it('blocks unsupported routing, including direct submit, but allows switching to manual entry', async () => {
    mocked.getSshConfigHosts.mockResolvedValue({ ...importedConfig, hosts: [{ ...importedConfig.hosts[0], warning: 'ProxyJump 暂不支持，请保留跳板机路由。' }], warnings: ['quant-server 使用 ProxyJump'] });
    const user = await setup();
    await pickDevice(user, '左侧设备', 'SSH 配置', /^quant-server/);
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

  it('asks for a key passphrase only after trusting once, then reuses the live connection without saving a profile', async () => {
    const originalProfiles = JSON.stringify([{ name: 'manual-server', host: 'manual.example.com', port: 22, username: 'operator', authMethod: 'password' }]);
    localStorage.setItem('dropping.connections.v1', originalProfiles);
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh
      .mockRejectedValueOnce(new Error('无法读取私钥，请检查路径、格式和私钥密码'))
      .mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    await user.click(await screen.findByRole('button', { name: '信任并连接' }));
    expect(await screen.findByText('无法读取私钥，请检查路径、格式和私钥密码')).toBeTruthy();
    await user.type(screen.getByLabelText(/私钥口令/), 'session-only-passphrase');
    await user.click(screen.getByRole('button', { name: '继续连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.probeSsh).toHaveBeenCalledOnce();
    expect(mocked.connectSsh).toHaveBeenCalledTimes(2);
    expect(mocked.connectSsh.mock.calls[1][0]).toMatchObject({ host: '10.20.30.40', port: 2222, passphrase: 'session-only-passphrase', fingerprint: 'SHA256:imported-key' });
    expect(localStorage.getItem('dropping.connections.v1')).toBe(originalProfiles);
    expect(localStorage.getItem('dropping.connections.v1')).not.toContain('session-only-passphrase');
    await pickDevice(user, '左侧设备', 'SSH 配置', /^quant-server/);
    await waitFor(() => expect(screen.getByRole('button', { name: '左侧设备' }).textContent).toContain('quant-server'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocked.probeSsh).toHaveBeenCalledOnce();
    expect(mocked.connectSsh).toHaveBeenCalledTimes(2);
  });

  it('reloads changed SSH config without disconnecting sessions or reusing a stale endpoint', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    await user.click(await screen.findByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    mocked.getSshConfigHosts.mockResolvedValue({ ...importedConfig, hosts: [{ ...importedConfig.hosts[0], host: '10.20.30.50' }] });
    const callsBeforeReload = mocked.getSshConfigHosts.mock.calls.length;
    await user.click(screen.getByRole('button', { name: '右侧设备' }));
    await user.click(screen.getByRole('button', { name: '重新读取配置' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(mocked.getSshConfigHosts).toHaveBeenCalledTimes(callsBeforeReload + 1));
    expect(screen.getByRole('button', { name: '右侧设备' }).textContent).toContain('quant-server');
    expect(mocked.disconnect).not.toHaveBeenCalled();
    await pickDevice(user, '左侧设备', 'SSH 配置', /^quant-server/);
    expect(await screen.findByText('10.20.30.50:2222')).toBeTruthy();
    expect(mocked.probeSsh).toHaveBeenLastCalledWith('10.20.30.50', 2222);
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
async function pickDevice(user: ReturnType<typeof userEvent.setup>, pane: string, group: string, name: RegExp) {
  await user.click(screen.getByRole('button', { name: pane }));
  const panel = within(screen.getByRole('dialog', { name: `选择${pane}` }));
  await user.click(within(panel.getByRole('group', { name: group })).getByRole('button', { name }));
}
async function changeRightPath() {
  const right = within(screen.getByRole('region', { name: '右侧工作区' }));
  fireEvent.click(right.getByRole('button', { name: '编辑路径' }));
  fireEvent.change(right.getByLabelText('右侧目录路径'), { target: { value: destination } });
  fireEvent.submit(right.getByLabelText('右侧目录路径').closest('form')!);
  await waitFor(() => expect(screen.getByText('空目录')).toBeTruthy());
}

describe('device picker', () => {
  it('opens a saved profile in the connect form and removes it from storage', async () => {
    localStorage.setItem('dropping.connections.v1', JSON.stringify([{ name: 'manual-server', host: 'manual.example.com', port: 2200, username: 'operator', authMethod: 'password' }]));
    const user = await setup();
    await pickDevice(user, '左侧设备', '已保存的连接', /^manual-server/);
    expect((screen.getByLabelText('主机地址') as HTMLInputElement).value).toBe('manual.example.com');
    expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('2200');
    expect((screen.getByLabelText('连接来源') as HTMLSelectElement).value).toBe('saved:0');
    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(screen.getByRole('button', { name: '左侧设备' }));
    await user.click(screen.getByRole('button', { name: '删除 manual-server' }));
    expect(screen.queryByRole('group', { name: '已保存的连接' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('dropping.connections.v1')!)).toEqual([]);
  });

  it('filters devices, opens the highlighted one with Enter and disconnects from the panel', async () => {
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    mocked.disconnect.mockResolvedValue(undefined);
    const user = await setup();
    await user.click(screen.getByRole('button', { name: '右侧设备' }));
    await user.keyboard('10.20');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('10.20.30.40:2222')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '信任并连接' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '右侧设备' }).textContent).toContain('quant-server'));
    await user.click(screen.getByRole('button', { name: '右侧设备' }));
    const live = within(screen.getByRole('group', { name: '已连接' }));
    expect(live.getByRole('button', { name: /^quant-server/ }).getAttribute('aria-current')).toBe('true');
    await user.click(live.getByRole('button', { name: '断开 quant-server' }));
    await waitFor(() => expect(mocked.disconnect).toHaveBeenCalledWith('ssh-imported'));
    await waitFor(() => expect(screen.getByRole('button', { name: '右侧设备' }).textContent).toContain('此电脑'));
  });

  it('connects to a trusted key host without any dialog', async () => {
    localStorage.setItem('dropping.known-hosts.v1', JSON.stringify({ '10.20.30.40:2222': { fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' } }));
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    await waitFor(() => expect(screen.getByRole('button', { name: '右侧设备' }).textContent).toContain('quant-server'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    expect(mocked.connectSsh.mock.calls[0][0]).toMatchObject({ host: '10.20.30.40', port: 2222, fingerprint: 'SHA256:imported-key' });
  });

  it('stops on a changed host key and only trusts the new key after explicit confirmation', async () => {
    localStorage.setItem('dropping.known-hosts.v1', JSON.stringify({ '10.20.30.40:2222': { fingerprint: 'SHA256:old-key', keyType: 'ssh-ed25519' } }));
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.probeSsh.mockResolvedValue({ fingerprint: 'SHA256:new-key', keyType: 'ssh-ed25519' });
    mocked.connectSsh
      .mockRejectedValueOnce(new Error('SSH 握手失败；若主机指纹发生变化，请核实服务器身份'))
      .mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    const user = await setup();
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    expect((await screen.findByRole('alert')).textContent).toContain('主机指纹与上次信任的不一致');
    expect(screen.getByText('SHA256:old-key')).toBeTruthy();
    expect(screen.getByText('SHA256:new-key')).toBeTruthy();
    expect(mocked.connectSsh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '信任新指纹并连接' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.connectSsh.mock.calls[1][0]).toMatchObject({ fingerprint: 'SHA256:new-key' });
    expect(JSON.parse(localStorage.getItem('dropping.known-hosts.v1')!)['10.20.30.40:2222'].fingerprint).toBe('SHA256:new-key');
  });

  it('asks a trusted password host only for its password', async () => {
    localStorage.setItem('dropping.connections.v1', JSON.stringify([{ name: 'manual-server', host: 'manual.example.com', port: 2200, username: 'operator', authMethod: 'password' }]));
    localStorage.setItem('dropping.known-hosts.v1', JSON.stringify({ 'manual.example.com:2200': { fingerprint: 'SHA256:manual-key', keyType: 'ssh-ed25519' } }));
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-manual', name: 'manual-server', kind: 'ssh', host: 'manual.example.com', username: 'operator', home: '/home/operator' });
    const user = await setup();
    await pickDevice(user, '左侧设备', '已保存的连接', /^manual-server/);
    expect(document.activeElement).toBe(screen.getByLabelText('密码', { exact: true }));
    await user.keyboard('session-secret{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.probeSsh).not.toHaveBeenCalled();
    expect(mocked.connectSsh.mock.calls[0][0]).toMatchObject({ host: 'manual.example.com', port: 2200, password: 'session-secret', fingerprint: 'SHA256:manual-key' });
  });
});

describe('pane tabs', () => {
  it('opens a new tab from the device panel, keeps per-tab folders and closes tabs', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    expect(left.queryByRole('button', { name: /^关闭标签页/ })).toBeNull();
    await user.click(left.getByRole('button', { name: '新建标签页' }));
    const panel = within(screen.getByRole('dialog', { name: '选择左侧新标签页的设备' }));
    await user.click(within(panel.getByRole('group', { name: '已连接' })).getByRole('button', { name: /^此电脑/ }));
    expect(left.getAllByRole('button', { name: /^关闭标签页/ })).toHaveLength(2);
    await waitFor(() => expect(left.getByRole('button', { name: '左侧设备' }).textContent).toContain('source'));

    await user.dblClick(await left.findByText('outputs'));
    await waitFor(() => expect(left.getByRole('button', { name: '左侧设备' }).textContent).toContain('outputs'));
    expect(left.getByLabelText('左侧目录路径').getAttribute('title')).toBe(`${source}\\outputs`);

    await user.click(left.getByRole('button', { name: '切换到标签页 此电脑 · source' }));
    expect(left.getByLabelText('左侧目录路径').getAttribute('title')).toBe(source);
    expect(left.getByRole('button', { name: '左侧设备' }).textContent).toContain('source');

    await user.click(left.getAllByRole('button', { name: /^关闭标签页/ })[1]);
    expect(left.queryByRole('button', { name: /^关闭标签页/ })).toBeNull();
    expect(left.getByLabelText('左侧目录路径').getAttribute('title')).toBe(source);
    expect(within(screen.getByRole('region', { name: '右侧工作区' })).queryByRole('button', { name: /^关闭标签页/ })).toBeNull();
  });
});

describe('address bar', () => {
  it('jumps to an ancestor from a breadcrumb and edits the full path from the empty area', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const crumbs = within(left.getByLabelText('左侧目录路径'));
    expect(crumbs.getAllByRole('button').map(button => button.textContent)).toEqual(['C:', 'fixture', 'source', '']);
    expect(crumbs.getByRole('button', { name: '切换磁盘，当前 C:' })).toBeTruthy();
    await user.click(crumbs.getByRole('button', { name: 'fixture' }));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenLastCalledWith('local', 'C:\\fixture'));

    await user.click(left.getByRole('button', { name: '编辑路径' }));
    const input = left.getByLabelText('左侧目录路径') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await user.keyboard('{Escape}');
    expect(left.getByLabelText('左侧目录路径').tagName).toBe('DIV');

    const calls = mocked.listDirectory.mock.calls.length;
    await user.click(left.getByRole('button', { name: '编辑路径' }));
    await user.clear(left.getByLabelText('左侧目录路径'));
    await user.type(left.getByLabelText('左侧目录路径'), `${source}\\outputs{Enter}`);
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenCalledTimes(calls + 1));
    expect(mocked.listDirectory).toHaveBeenLastCalledWith('local', `${source}\\outputs`);
    expect(left.getByLabelText('左侧目录路径').tagName).toBe('DIV');
  });
});

describe('parent row and drives', () => {
  it('goes up from the .. row by double-click or Enter without transferring it', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const parentRow = left.getByText('..').closest('tr')!;
    expect(parentRow).toBe(left.getAllByRole('row')[1]);
    await user.dblClick(left.getByText('..'));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenLastCalledWith('local', 'C:\\fixture'));
    expect(mocked.startTransfer).not.toHaveBeenCalled();

    const list = screen.getByLabelText('右侧文件列表，空格预览，回车打开或传输');
    fireEvent.focus(list);
    fireEvent.keyDown(list, { key: 'ArrowDown', bubbles: true });
    expect(within(screen.getByRole('region', { name: '右侧工作区' })).getByText('..').closest('tr')!.getAttribute('aria-selected')).toBe('true');
    expect((within(screen.getByRole('region', { name: '右侧工作区' })).getByRole('button', { name: /Drop/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(list, { key: 'Enter', bubbles: true });
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenCalledTimes(4));
    expect(mocked.startTransfer).not.toHaveBeenCalled();
  });

  it('switches drives from the address bar and treats a bare drive letter as its root', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByRole('button', { name: '切换磁盘，当前 C:' }));
    const menu = within(left.getByRole('menu', { name: '磁盘' }));
    expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['C:', 'D:']);
    await user.click(menu.getByRole('menuitem', { name: 'D:' }));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenLastCalledWith('local', 'D:\\'));
    expect(left.queryByRole('menu')).toBeNull();

    await user.click(left.getByRole('button', { name: '编辑路径' }));
    await user.clear(left.getByLabelText('左侧目录路径'));
    await user.type(left.getByLabelText('左侧目录路径'), 'e:{Enter}');
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenLastCalledWith('local', 'E:\\'));
  });
});

describe('window chrome', () => {
  it('drives the frameless window controls and closes the queue panel with Escape', async () => {
    appWindow.isMaximized.mockResolvedValue(true);
    const user = await setup();
    await user.click(screen.getByRole('button', { name: '最小化' }));
    expect(appWindow.minimize).toHaveBeenCalledOnce();
    await user.click(await screen.findByRole('button', { name: '向下还原' }));
    expect(appWindow.toggleMaximize).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /^传输队列/ }));
    expect(screen.getByRole('dialog', { name: '传输队列' }).textContent).toContain('暂无任务');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '传输队列' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(appWindow.close).toHaveBeenCalledOnce();
  });

  it('toggles maximize on every title bar double-click and drags only after the pointer moves', async () => {
    await setup();
    const titlebar = screen.getByRole('banner');
    fireEvent.mouseDown(titlebar, { button: 0, detail: 1, clientX: 300, clientY: 20 });
    fireEvent.mouseUp(titlebar, { button: 0 });
    fireEvent.doubleClick(titlebar);
    fireEvent.doubleClick(titlebar);
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(2);
    expect(appWindow.startDragging).not.toHaveBeenCalled();
    fireEvent.mouseDown(titlebar, { button: 0, detail: 1, clientX: 300, clientY: 20 });
    fireEvent.mouseMove(titlebar, { buttons: 1, clientX: 301, clientY: 21 });
    expect(appWindow.startDragging).not.toHaveBeenCalled();
    fireEvent.mouseMove(titlebar, { buttons: 1, clientX: 320, clientY: 24 });
    expect(appWindow.startDragging).toHaveBeenCalledOnce();
    fireEvent.doubleClick(screen.getByRole('button', { name: '刷新' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: '刷新' }), { button: 0, detail: 1 });
    fireEvent.mouseMove(titlebar, { buttons: 1, clientX: 400, clientY: 30 });
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(2);
    expect(appWindow.startDragging).toHaveBeenCalledOnce();
  });
});

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

  it('toggles the preview with Space', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByText('report.txt'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(await screen.findByText('研究产物预览')).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(await screen.findByText('研究产物预览')).toBeTruthy();
  });

  it('renders markdown safely with a source toggle and highlights code with line numbers', async () => {
    mocked.listDirectory.mockImplementation(async (_id: string, path: string) => ({ path, parent: null, entries: [
      { name: 'README.md', path: `${path}/README.md`, isDir: false, isSymlink: false, size: 64, modified: null },
      { name: 'train.py', path: `${path}/train.py`, isDir: false, isSymlink: false, size: 32, modified: null },
    ] }));
    const markdown = `# 研究笔记

- [x] 完成回测

[文档](https://example.com) <script>alert(1)</script>

\`\`\`python
def run():
    return 1
\`\`\`
`;
    const python = `import os

def main():
    return os.getcwd()
`;
    mocked.previewFile.mockImplementation(async (_id: string, path: string) => path.endsWith('README.md')
      ? { kind: 'text', content: markdown, mime: 'text/markdown', size: 64, truncated: false }
      : { kind: 'text', content: python, mime: 'text/x-python', size: 32, truncated: false });
    const user = userEvent.setup();
    render(<StrictMode><App /></StrictMode>);
    const left = within(await screen.findByRole('region', { name: '左侧工作区' }));
    await user.click(await left.findByText('README.md'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('heading', { level: 1, name: '研究笔记' })).toBeTruthy();
    expect((dialog.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(dialog.getByRole('link', { name: '文档' }).getAttribute('href')).toBe('https://example.com');
    expect(document.querySelector('.markdown-body script')).toBeNull();
    expect(document.querySelector('.markdown-body .hljs-keyword')?.textContent).toBe('def');
    expect(dialog.getByRole('button', { name: '源码' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(dialog.getByRole('button', { name: '源码' }));
    expect(dialog.getByRole('button', { name: '源码' }).getAttribute('aria-pressed')).toBe('true');
    expect(dialog.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('.code-body')?.textContent).toContain('# 研究笔记');
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(left.getByText('train.py'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.querySelector('.code-body .hljs-keyword')?.textContent).toBe('import'));
    expect(document.querySelector('.code-gutter')?.textContent?.split(/\s+/)).toEqual(['1', '2', '3', '4']);
    expect(screen.queryByRole('button', { name: '源码' })).toBeNull();
  });

  it('renders CSV as a table with a source toggle and reads Parquet through byte ranges', async () => {
    mocked.listDirectory.mockImplementation(async (_id: string, path: string) => ({ path, parent: null, entries: [
      { name: 'metrics.csv', path: `${path}/metrics.csv`, isDir: false, isSymlink: false, size: 64, modified: null },
      { name: 'broken.parquet', path: `${path}/broken.parquet`, isDir: false, isSymlink: false, size: 16, modified: null },
    ] }));
    mocked.previewFile.mockResolvedValue({ kind: 'text', content: 'model,excess,note\nv3,8.2,"base, old"\nv4,11.6,\n', mime: 'text/csv', size: 64, truncated: false });
    const bytes = new TextEncoder().encode('definitely no PAR1').buffer;
    mocked.readFileRange.mockImplementation(async (_id: string, _path: string, offset: number, length: number) => bytes.slice(offset, offset + length));
    const user = userEvent.setup();
    render(<StrictMode><App /></StrictMode>);
    const left = within(await screen.findByRole('region', { name: '左侧工作区' }));
    await user.click(await left.findByText('metrics.csv'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['', 'model', 'excess', 'note']);
    expect(dialog.getByRole('cell', { name: 'base, old' })).toBeTruthy();
    expect(dialog.getByText('共 2 行')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: '源码' }));
    expect(dialog.queryByRole('table')).toBeNull();
    expect(document.querySelector('.code-body')?.textContent).toContain('v3,8.2,"base, old"');
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });

    await user.click(left.getByText('broken.parquet'));
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(await screen.findByText(/无法解析 Parquet 文件/)).toBeTruthy();
    expect(mocked.readFileRange).toHaveBeenCalledWith('local', expect.stringMatching(/broken\.parquet$/), expect.any(Number), expect.any(Number));
    expect(mocked.previewFile).toHaveBeenCalledTimes(1);
  });

  it('uses focused right pane for keyboard selection and preview', async () => {
    await setup();
    const list = screen.getByLabelText('右侧文件列表，空格预览，回车打开或传输');
    fireEvent.focus(list);
    fireEvent.keyDown(list, { key: 'ArrowDown', bubbles: true });
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
    expect(screen.queryByRole('dialog', { name: '传输队列' })).toBeNull();
    expect(within(screen.getByRole('button', { name: /^传输队列/ })).getByText('2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^传输队列/ }));
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
    expect(JSON.parse(localStorage.getItem('dropping.known-hosts.v1')!)).toEqual({ '127.0.0.1:22': { fingerprint: 'SHA256:test-key', keyType: 'ssh-ed25519' } });
  });
});
