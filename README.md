<p align="center">
  <img src="public/dropping.svg" width="88" height="88" alt="Dropping logo">
</p>

# Dropping

**把两台电脑放进同一个窗口，让文件在设备间流动。**

Dropping 是使用 **Rust + Tauri 2 + React** 构建的双栏 SFTP 文件传输客户端，适合在多台电脑和服务器上运行任务、反复转移模型、报表、日志等产物的工作方式。

左右工作区各代表一台设备：选好目标目录，双击文件即可传到另一侧；按空格直接预览内容。远程设备只需提供 SSH/SFTP 服务。

[下载 Windows x64 版](https://github.com/nnquant/dropping/releases/latest) · [报告问题](https://github.com/nnquant/dropping/issues) · [源代码](https://github.com/nnquant/dropping)

## 功能

- **双侧浏览**：本机与多个 SSH 连接自由切换，支持目录导航、路径输入、筛选、排序和点文件显示。
- **双向传输**：本机与服务器、服务器与服务器、本机目录之间复制文件或整个文件夹。
- **快速预览**：空格查看 UTF-8 文本、代码及 PNG、JPEG、GIF、WebP、BMP 图片。
- **传输队列**：顺序执行任务，显示进度、完成状态和错误，支持取消。
- **SSH 配置导入**：启动时读取本机 `~/.ssh/config`，将服务器别名加入两侧设备列表。
- **连接确认**：支持密码或单个私钥认证，新建连接前显示 SSH 主机密钥指纹，确认后才提交认证信息。

## 安装与使用

### Windows x64

在 [Releases](https://github.com/nnquant/dropping/releases/latest) 下载 **0.1.1** 版：

- **安装版**：下载 `Dropping_0.1.1_x64-setup.exe`，运行安装程序。
- **便携版**：下载 Windows x64 portable ZIP，完整解压后运行其中的 Dropping 程序。请保留同包的 `LICENSE` 和 `THIRD_PARTY_NOTICES.txt`。

运行需要 Microsoft Edge WebView2 Runtime。

1. 两侧默认打开本机目录。在设备列表的「SSH 配置」分组选一个服务器，或点击「新建连接」手动填写。
2. 填写密码或私钥口令，通过服务器控制台或已信任的渠道核对主机指纹，再点击「信任并连接」。
3. 在另一侧打开目标目录。双击文件加入传输队列；双击文件夹进入目录，传输文件夹时使用底部「传到左侧 / 右侧」按钮。
4. 选中文件后按空格预览，在底部队列查看结果。目标同名项已存在时会报错，**不会覆盖，也不会合并已有目录**。

Windows 本机路径支持直接输入绝对路径，例如 `D:\projects\outputs`。

### 平台状态

当前桌面构建与安装包在 **Windows x64** 上验证。项目采用 Tauri 跨平台技术栈，但 **macOS 和 Linux 尚未完成实际构建与运行验证**，目前不提供对应的预编译包。

## 自动读取 SSH 配置

启动时读取本机 `~/.ssh/config`，Windows 对应 `%USERPROFILE%\.ssh\config`。以下为通用示例，请换成自己的服务器信息：

```sshconfig
Host compute
    HostName compute.example.com
    User researcher
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host archive
    HostName archive.example.com
    User deploy
    IdentityFile ~/.ssh/id_ed25519

Host *
    Port 22
```

`compute` 和 `archive` 会出现在两侧设备菜单及连接窗口的「SSH 配置」分组。选择后自动填入地址、端口、用户名和私钥路径，**不会自动连接或发送凭据**。重新选择已连接的导入项会复用现有会话。

- 支持 `Include`、多个主机别名和通配符默认配置；标量选项按先取得的值优先。仅把明确的主机别名列为设备，`Host *` 不会变成单独的设备。
- 未指定私钥时，会检查默认 `id_ed25519`、`id_rsa` 文件是否存在；导入时不读取私钥内容。没有可用私钥路径时使用密码认证表单。
- 标题下方显示配置来源与导入数量，可单独刷新；顶部「刷新」也会重读配置，保留已连接的会话。
- 导入项不会写回 SSH 配置，也不会另存到手动连接记录。导入参数在表单中只读；需要调整时可选择「手动填写连接信息」。
- 配置缺失或读取失败不影响本机浏览和手动连接，读取问题会显示在配置提示中。

配置导入覆盖常见用法，**并非完整的 OpenSSH 配置实现**。`ProxyJump`、`ProxyCommand`、证书认证、多个不同的私钥及不支持的条件配置等，会对相关导入项显示说明并阻止连接。读取配置不会执行 `Match exec` 或代理命令；Dropping 不会代为建立跳板机路由。

## 操作与快捷键

在文件列表获得焦点且没有打开弹窗时：

| 操作 | 行为 |
| --- | --- |
| 双击文件 | 传输到对侧当前目录 |
| 双击文件夹 | 打开文件夹 |
| `↑` / `↓` | 选择文件或文件夹 |
| `Enter` | 打开选中的文件夹，或传输选中的文件 |
| `Space` | 预览选中的文件 |
| `Esc` | 关闭预览或非连接中的弹窗 |
| `Ctrl+R` / `Cmd+R` | 刷新当前工作区目录 |

输入框内的按键保留其正常输入行为。文件夹传输使用工作区底部的传输按钮。

## 传输方式与边界

```text
服务器 A ── SFTP / SSH ── Dropping 客户端 ── SFTP / SSH ── 服务器 B
```

远程到远程的文件经运行 Dropping 的电脑**流式转发**，不会先下载完整文件再上传。服务器不需要彼此连通，但客户端必须能访问两端，速度也受客户端网络影响。本机目录间复制直接使用本机文件系统。

- 传输是复制，保留来源文件。不执行同步删除，不保留源文件的时间戳、权限、所有者等元数据。
- 任务顺序执行，暂无并行队列、断点续传或自动重试。检测到源文件的大小或修改时间在传输时变化，会停止任务；建议等待产物写入完成后再传输。
- 拒绝符号链接和特殊文件；文件夹中出现此类项目会中止任务。单次目录传输最多 64 层、100,000 项。
- 文件夹的目标内容会逐步出现，是否完成以队列为准。取消或失败时会尝试清理由本任务创建的目标项，清理失败会显示错误。
- 本机目标通过硬链接完成不覆盖提交，已验证 Windows NTFS；exFAT 及部分网络文件系统可能不支持，会返回错误。
- 关闭客户端会中断任务。建议先取消并等待队列结束；进程被强制终止时可能留下临时文件。
- 文本预览最多显示前 **256 KiB**，图片上限 **8 MiB**。HTML / SVG 不作为网页执行，其他二进制格式暂不支持预览。

## 安全与凭据

远程传输通过 SSH 加密。每次新建 SSH 会话都需要确认主机指纹，实际认证连接会在发送凭据前核对指纹。当前不读取或维护 OpenSSH `known_hosts`，也不持久保存主机信任记录。

手动连接的名称、地址、端口、用户名、认证方式和私钥路径保存在客户端本地存储中；**密码和私钥口令不写入该存储**。私钥只在连接认证时从用户提供的本机路径加载，应用不会复制保存私钥文件。

Dropping 没有账户系统或云端中继。目前不支持 SSH agent、跳板机、代理命令、证书认证及交互式多因素认证。

## 从源码运行

需要 Node.js 22+、npm、Rust，以及目标平台的 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。Windows 需要 Visual Studio C++ Build Tools 和 WebView2。仓库通过 `rust-toolchain.toml` 固定 Rust **1.95.0**。

```powershell
git clone https://github.com/nnquant/dropping.git
cd dropping
npm ci
npm run desktop
```

仅查看网页界面：

```powershell
npm run dev
```

打开 `http://127.0.0.1:1420`。浏览器模式只能预览界面，本机文件和 SSH 操作需要桌面客户端。

构建 Windows 安装包：

```powershell
npm run desktop:build
```

可执行文件位于 `src-tauri/target/release/`，NSIS 安装包位于 `src-tauri/target/release/bundle/nsis/`。安装了相应平台依赖后，可在 macOS / Linux 上尝试 `npm run tauri -- build`；这些平台尚未验证。

## 测试

```powershell
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

测试覆盖工作区操作、预览、串行队列、SSH 配置导入与连接复用、指纹确认、文件路径处理和传输行为。

真实 SFTP 集成测试需要 Python 与 Paramiko，在 Windows 上运行：

```powershell
python -m pip install paramiko==5.0.0
npm run test:sftp
```

脚本创建两个仅监听 `127.0.0.1` 的独立 SFTP 端点，验证认证、指纹拒绝、上传、下载、远程中转、目录传输、冲突保护与取消清理。测试结束后关闭端点，产物保存在 `work/`，不会访问用户的服务器。详见 [测试说明](tests/README.md)。

## 贡献

请先阅读 [贡献指南](CONTRIBUTING.md)。欢迎通过 [Issues](https://github.com/nnquant/dropping/issues) 提交问题或建议，通过 Pull Request 提交改动。问题报告请包含系统与应用版本、复现步骤和经过脱敏的错误信息；不要上传密码、私钥、真实 SSH 配置或带私人服务器信息的截图。

提交前请运行与改动相关的测试，并保持现有双栏工作流与中文界面风格。涉及文件覆盖、取消清理、认证或 SSH 配置解析的修改，请提供回归测试。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。可用于个人和商业用途，可使用、修改及分发，但须保留原版权声明和许可声明。软件按原样提供，不附带担保；第三方依赖遵循各自的许可证，详见 [第三方声明](THIRD_PARTY_NOTICES.txt)。
