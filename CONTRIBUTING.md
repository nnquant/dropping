# 参与开发

Dropping 0.1.1 使用 Rust、Tauri 2、React 和 TypeScript。当前已验证的开发与打包路径是 Windows；欢迎提交 macOS、Linux 适配，但请附上对应系统的实际构建和运行结果。

## 准备环境

- Windows 10/11、Microsoft Edge WebView2 Runtime。
- Visual Studio 2022 Build Tools，安装「使用 C++ 的桌面开发」及 Windows SDK。
- Node.js 22、npm。
- 通过 rustup 安装 Rust。仓库的 `rust-toolchain.toml` 固定工具链版本，目前为 `1.95.0`，进入仓库后 rustup 会使用该版本。
- 需要运行 SFTP 集成测试时，准备 Python 3.12 和 Paramiko。

在仓库根目录执行：

```powershell
npm ci
npm run desktop
```

`npm run desktop` 启动原生客户端及开发服务器。只需调试界面时可运行 `npm run dev`；浏览器预览不能调用本机文件或 SSH/SFTP 功能。

## 提交前检查

```powershell
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
rustup component add rustfmt
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

常规 Rust 测试使用仓库内的合成数据，不读取真实 SSH 配置。需要验证传输时再执行：

```powershell
python -m pip install paramiko==5.0.0
npm run test:sftp
```

集成测试会启动两台仅监听本机的 SFTP 测试服务器，覆盖主机指纹核对、密码/密钥认证、浏览和预览、文件往返、服务器之间转传、目录递归、冲突保护及取消清理。详情见 [测试说明](tests/README.md)。不要直接使用 `cargo test -- --ignored`：另一个忽略的诊断测试会读取本机 SSH 配置，只有明确需要检查自己的配置时才运行。

检查 Windows 安装包时执行：

```powershell
npm run desktop:build
```

该命令生成 NSIS 安装包，默认输出到 `src-tauri/target/release/bundle/nsis/`。设置了 `CARGO_TARGET_DIR` 时，输出位于相应目录。当前 Windows CI 执行前端检查、Rust 测试和真实 SFTP 集成测试；它不代替安装包或其他操作系统的手动验收。

## 修改与提交

- 尽量在现有模块内解决问题，保持双工作区的简洁交互、中文文案及现有代码风格。
- 修复错误时，说明触发条件、修复后的行为和执行过的检查。涉及传输、路径、SSH 配置解析的改动，补充能复现问题的合成测试。
- 保持主机指纹在认证前校验、同名目标不覆盖、取消后仅清理本任务创建的文件。SSH 配置解析不得执行 `Match exec` 或 `ProxyCommand`。
- 不要提交真实密码、私钥、SSH 配置、服务器清单、日志中的敏感内容，或 `work/` 中的测试产物。锁文件随对应依赖变更一同提交。
- 提交界面改动时附上截图；提交平台支持改动时注明系统版本、工具链和验证范围。

项目使用 [MIT 许可证](LICENSE)。提交贡献时，请确保你有权提交相关代码，并同意按项目的 MIT 许可证提供这些贡献。
