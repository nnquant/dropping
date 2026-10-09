import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectoryListing, SshConfigHosts, TransferResult } from '../src/types';

const mocked = vi.hoisted(() => ({
  getLocalInfo: vi.fn(), listDirectory: vi.fn(), previewFile: vi.fn(), startTransfer: vi.fn(),
  cancelTransfer: vi.fn(), disconnect: vi.fn(), probeSsh: vi.fn(), connectSsh: vi.fn(),
  onTransferProgress: vi.fn(), getSshConfigHosts: vi.fn(), readFileRange: vi.fn(), listDrives: vi.fn(),
  createFolder: vi.fn(), renameEntry: vi.fn(), moveEntry: vi.fn(), deleteEntry: vi.fn(),
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
  mocked.createFolder.mockResolvedValue(`${source}\\新建文件夹`);
  mocked.renameEntry.mockResolvedValue(`${source}\\renamed.txt`);
  mocked.moveEntry.mockResolvedValue(`${destination}\\report.txt`);
  mocked.deleteEntry.mockResolvedValue(undefined);
});

describe('file toolbar', () => {
  it('disables selection actions and never acts on the parent row', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    for (const name of ['剪切', '复制', '粘贴', '重命名', '删除']) expect((left.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(left.getByText('..'));
    await user.keyboard('{F2}{Delete}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
  });

  it('creates a folder in the captured directory and refreshes both matching panes', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByRole('button', { name: '新建文件夹' }));
    const dialog = within(screen.getByRole('dialog', { name: '新建文件夹' }));
    await user.clear(dialog.getByLabelText('文件夹名称'));
    await user.type(dialog.getByLabelText('文件夹名称'), '研究产物');
    mocked.listDirectory.mockClear();
    await user.click(dialog.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocked.createFolder).toHaveBeenCalledWith('local', source, '研究产物');
    expect(mocked.listDirectory).toHaveBeenCalledTimes(2);
  });

  it('shows rename conflicts without closing the dialog or losing the name', async () => {
    mocked.renameEntry.mockRejectedValueOnce(new Error('目标已存在，未覆盖'));
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByText('report.txt'));
    await user.keyboard('{F2}');
    const dialog = within(screen.getByRole('dialog', { name: '重命名' }));
    const input = dialog.getByLabelText('新名称') as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(6);
    await user.clear(input);
    await user.type(input, 'renamed.txt');
    await user.click(dialog.getByRole('button', { name: '保存' }));
    expect(await dialog.findByRole('alert')).toBeTruthy();
    expect(input.value).toBe('renamed.txt');
    expect(mocked.renameEntry).toHaveBeenCalledWith('local', source, 'report.txt', 'renamed.txt');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies through the transfer queue and retains clipboard for another paste', async () => {
    mocked.startTransfer.mockResolvedValue({ targetPath: `${destination}\\report.txt`, bytes: 12, files: 1 });
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const right = within(screen.getByRole('region', { name: '右侧工作区' }));
    await user.click(left.getByText('report.txt'));
    await user.keyboard('{Control>}c{/Control}');
    await changeRightPath();
    await user.click(right.getByRole('button', { name: '粘贴' }));
    await waitFor(() => expect(mocked.startTransfer).toHaveBeenCalledOnce());
    expect(mocked.startTransfer.mock.calls[0][0]).toMatchObject({ sourceConnectionId: 'local', sourcePath: `${source}\\report.txt`, destinationDirectory: destination });
    await waitFor(() => expect((right.getByRole('button', { name: '粘贴' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('moves a cut file only when pasted and clears clipboard on success', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const right = within(screen.getByRole('region', { name: '右侧工作区' }));
    await user.click(left.getByText('report.txt'));
    await user.click(left.getByRole('button', { name: '剪切' }));
    expect(left.getAllByText('report.txt').some(item => item.closest('tr')?.classList.contains('cut-row'))).toBe(true);
    expect(mocked.moveEntry).not.toHaveBeenCalled();
    await changeRightPath();
    await user.click(right.getByRole('button', { name: '粘贴' }));
    await waitFor(() => expect(mocked.moveEntry).toHaveBeenCalledWith('local', source, 'report.txt', destination));
    await waitFor(() => expect((right.getByRole('button', { name: '粘贴' }) as HTMLButtonElement).disabled).toBe(true));
    expect(mocked.startTransfer).not.toHaveBeenCalled();
  });

  it('requires a separate permanent-delete confirmation and cancel performs no write', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByText('outputs'));
    await user.keyboard('{Delete}');
    expect(screen.getByText(/此操作不进入回收站/)).toBeTruthy();
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
    await user.click(left.getByRole('button', { name: '删除' }));
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(mocked.deleteEntry).toHaveBeenCalledWith('local', source, 'outputs'));
  });

  it('changes sorting, toggles compact rows, and displays properties', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByRole('button', { name: '排序方式' }));
    await user.click(left.getByRole('group', { name: '排序选项' }).querySelector('button')!);
    await user.click(left.getByRole('button', { name: '排序方式' }));
    await user.click(within(left.getByRole('group', { name: '排序选项' })).getByRole('button', { name: '降序' }));
    expect(left.getByRole('columnheader', { name: '名称' }).getAttribute('aria-sort')).toBe('descending');
    await user.click(left.getByRole('button', { name: '更多文件操作' }));
    await user.click(left.getByRole('button', { name: '紧凑视图' }));
    expect(left.getByLabelText(/左侧文件列表/).classList.contains('is-compact')).toBe(true);
    await user.click(left.getByText('report.txt'));
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    const dialog = within(screen.getByRole('dialog', { name: '属性' }));
    expect(dialog.getByText(`${source}\\report.txt`)).toBeTruthy();
    expect(dialog.getByText(/12 字节/)).toBeTruthy();
  });
});

describe('workspace context menus', () => {
  it('selects the right-clicked file and renames that file instead of the old selection', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const report = left.getByRole('row', { name: /report.txt/ });
    await user.click(left.getByRole('row', { name: /model.bin/ }));
    fireEvent.contextMenu(report, { clientX: 120, clientY: 200 });
    expect(report.getAttribute('aria-selected')).toBe('true');
    const menu = within(screen.getByRole('menu', { name: '项目右键菜单' }));
    expect(menu.getByRole('menuitem', { name: /预览/ })).toBeTruthy();
    expect(menu.queryByRole('menuitem', { name: '打开文件夹' })).toBeNull();
    await user.click(menu.getByRole('menuitem', { name: /重命名/ }));
    const input = screen.getByLabelText('新名称') as HTMLInputElement;
    expect(input.value).toBe('report.txt');
    await user.clear(input);
    await user.type(input, '新的报告.txt');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mocked.renameEntry).toHaveBeenCalledWith('local', source, 'report.txt', '新的报告.txt'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('previews files and opens folders in new tabs using different menus', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    fireEvent.contextMenu(left.getByRole('row', { name: /report.txt/ }));
    await user.click(screen.getByRole('menuitem', { name: /预览/ }));
    expect(await screen.findByText('研究产物预览')).toBeTruthy();
    expect(mocked.previewFile).toHaveBeenCalledWith('local', `${source}\\report.txt`);
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(left.getByRole('row', { name: /outputs/ }));
    expect(screen.queryByRole('menuitem', { name: /预览/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /打开文件夹/ })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: '在新标签页中打开' }));
    await waitFor(() => expect(mocked.listDirectory).toHaveBeenCalledWith('local', `${source}\\outputs`));
    expect(left.getAllByRole('button', { name: /^关闭标签页/ })).toHaveLength(2);
    expect(mocked.startTransfer).not.toHaveBeenCalled();
  });

  it('pastes into the right-clicked folder without navigating the pane', async () => {
    mocked.startTransfer.mockResolvedValue({ targetPath: `${source}\\outputs\\report.txt`, bytes: 12, files: 1 });
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const right = within(screen.getByRole('region', { name: '右侧工作区' }));
    fireEvent.contextMenu(left.getByRole('row', { name: /report.txt/ }));
    await user.click(screen.getByRole('menuitem', { name: /^复制 Ctrl/ }));
    fireEvent.contextMenu(right.getByRole('row', { name: /outputs/ }));
    await user.click(screen.getByRole('menuitem', { name: '粘贴到此文件夹' }));
    await waitFor(() => expect(mocked.startTransfer).toHaveBeenCalledOnce());
    expect(mocked.startTransfer.mock.calls[0][0]).toMatchObject({ sourcePath: `${source}\\report.txt`, destinationDirectory: `${source}\\outputs` });
    expect(right.getByLabelText('右侧目录路径').getAttribute('title')).toBe(source);
  });

  it('shows a background menu, clears selection, and never deletes the parent row', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    await user.click(left.getByRole('row', { name: /report.txt/ }));
    fireEvent.contextMenu(left.getByLabelText(/左侧文件列表/));
    const menu = within(screen.getByRole('menu', { name: '工作区右键菜单' }));
    expect(menu.queryByRole('menuitem', { name: /删除/ })).toBeNull();
    expect((menu.getByRole('menuitem', { name: /^粘贴/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(left.getByRole('row', { name: /report.txt/ }).getAttribute('aria-selected')).toBe('false');
    await user.click(menu.getByRole('menuitem', { name: /新建文件夹/ }));
    expect(screen.getByRole('dialog', { name: '新建文件夹' })).toBeTruthy();
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(left.getByText('..'));
    expect(screen.getByRole('menu', { name: '工作区右键菜单' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /删除/ })).toBeNull();
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
  });

  it('transfers right-clicked folders to the opposite pane and keeps delete confirmation', async () => {
    mocked.startTransfer.mockResolvedValue({ targetPath: `${destination}\\outputs`, bytes: 0, files: 0 });
    const user = await setup();
    await changeRightPath();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    fireEvent.contextMenu(left.getByRole('row', { name: /outputs/ }));
    await user.click(screen.getByRole('menuitem', { name: '传输到右侧' }));
    await waitFor(() => expect(mocked.startTransfer).toHaveBeenCalledOnce());
    expect(mocked.startTransfer.mock.calls[0][0]).toMatchObject({ sourcePath: `${source}\\outputs`, destinationDirectory: destination });
    fireEvent.contextMenu(left.getByRole('row', { name: /outputs/ }));
    await user.click(screen.getByRole('menuitem', { name: /^删除/ }));
    expect(screen.getByRole('dialog', { name: '删除确认' })).toBeTruthy();
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(mocked.deleteEntry).not.toHaveBeenCalled();
  });

  it('supports keyboard invocation and navigation, Escape, outside click and scroll dismissal', async () => {
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const list = left.getByLabelText(/左侧文件列表/);
    await user.click(left.getByRole('row', { name: /report.txt/ }));
    list.focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = within(screen.getByRole('menu'));
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: /预览/ }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: /^剪切/ }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(list);
    fireEvent.contextMenu(list);
    await user.click(screen.getByRole('button', { name: '右侧设备' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.keyboard('{Escape}');
    fireEvent.contextMenu(list);
    fireEvent.scroll(list);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows symlink properties while disabling file mutations', async () => {
    mocked.listDirectory.mockImplementation(async (_id: string, path: string) => ({ ...listing(path), entries: [{ name: 'link', path: `${path}\\link`, isDir: false, isSymlink: true, size: 0, modified: null }] }));
    const user = userEvent.setup();
    render(<App />);
    const links = await screen.findAllByText('link');
    fireEvent.contextMenu(links[0]);
    for (const name of [/预览/, /^剪切/, /^复制 Ctrl/, /重命名/, /^删除/]) expect((screen.getByRole('menuitem', { name }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('menuitem', { name: /属性/ }));
    expect(screen.getByRole('dialog', { name: '属性' })).toBeTruthy();
    expect(screen.getByText('符号链接')).toBeTruthy();
  });
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

describe('status bar', () => {
  it('shows ready in green, then a failed transfer in red until dismissed', async () => {
    const user = await setup();
    const status = within(screen.getByRole('contentinfo'));
    expect(status.getByText('就绪')).toBeTruthy();
    expect(document.querySelector('.statusbar .dot.is-ok')).toBeTruthy();
    await changeRightPath();
    mocked.startTransfer.mockRejectedValue(new Error('目标目录已存在同名文件'));
    await user.dblClick(within(screen.getByRole('region', { name: '左侧工作区' })).getByText('report.txt'));
    const problem = await status.findByRole('button', { name: /report\.txt 传输失败：目标目录已存在同名文件/ });
    expect(document.querySelector('.statusbar .dot.is-error')).toBeTruthy();
    expect(status.queryByText('就绪')).toBeNull();
    await user.click(problem);
    expect(status.getByText('就绪')).toBeTruthy();
  });

  it('reports a dropped remote connection but not ordinary path errors', async () => {
    localStorage.setItem('dropping.known-hosts.v1', JSON.stringify({ '10.20.30.40:2222': { fingerprint: 'SHA256:imported-key', keyType: 'ssh-ed25519' } }));
    mocked.getSshConfigHosts.mockResolvedValue(importedConfig);
    mocked.connectSsh.mockResolvedValue({ id: 'ssh-imported', name: 'quant-server', kind: 'ssh', host: '10.20.30.40', username: 'research', home: '/home/research' });
    mocked.listDirectory.mockImplementation(async (id: string, path: string) => {
      if (id !== 'ssh-imported') return listing(path);
      if (path === '/home/research') return { path, parent: '/home', entries: [{ name: 'secret', path: '/home/research/secret', isDir: true, isSymlink: false, size: 0, modified: null }] };
      if (path === '/home/research/secret') throw new Error('Permission denied');
      throw new Error('连接已断开，请重新连接');
    });
    const user = await setup();
    const status = within(screen.getByRole('contentinfo'));
    await pickDevice(user, '右侧设备', 'SSH 配置', /^quant-server/);
    const right = within(screen.getByRole('region', { name: '右侧工作区' }));
    await user.dblClick(await right.findByText('secret'));
    expect(await right.findByText('Permission denied')).toBeTruthy();
    expect(status.getByText('就绪')).toBeTruthy();
    await user.click(right.getByRole('button', { name: 'home' }));
    expect(await status.findByRole('button', { name: /quant-server 连接异常：连接已断开/ })).toBeTruthy();
  });
});

describe('hidden files', () => {
  it('toggles dotfiles per pane from its toolbar', async () => {
    mocked.listDirectory.mockImplementation(async (_id: string, path: string) => ({ path, parent: null, entries: [
      { name: 'report.txt', path: `${path}/report.txt`, isDir: false, isSymlink: false, size: 12, modified: null },
      { name: '.env', path: `${path}/.env`, isDir: false, isSymlink: false, size: 4, modified: null },
    ] }));
    const user = await setup();
    const left = within(screen.getByRole('region', { name: '左侧工作区' }));
    const right = within(screen.getByRole('region', { name: '右侧工作区' }));
    expect(left.queryByText('.env')).toBeNull();
    const toggle = left.getByRole('button', { name: '显示隐藏文件' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(left.getByText('.env')).toBeTruthy();
    expect(right.queryByText('.env')).toBeNull();
    await user.click(toggle);
    expect(left.queryByText('.env')).toBeNull();
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
