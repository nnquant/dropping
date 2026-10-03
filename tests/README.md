# SFTP 集成测试

这些测试使用实际 Rust SSH/SFTP 代码连接两个独立的本机测试服务器。不会连接生产服务器。

需要项目 Rust 工具链，以及已安装 `paramiko` 的 Python。下面是当前已验证的 Windows 测试流程，请在仓库根目录运行：

```powershell
python -m pip install paramiko==5.0.0
npm run test:sftp
# 使用项目自己的 Python 虚拟环境时：
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run-sftp-tests.ps1 -Python .\.venv\Scripts\python.exe
```

测试夹具仅监听 `127.0.0.1` 的随机端口，生成独立 SSH 主机密钥和客户端私钥，提供密码与密钥认证。文件、日志、测试结果全部保存在 `work/sftp-tests-*/`。脚本结束时自动关闭服务器，并恢复原来的 `DROPPING_SFTP_FIXTURE` 环境变量。

需要手动调试时，在一个终端运行：

```powershell
python tests/sftp_fixture.py
```

把启动输出里的 `manifest` 路径设为另一终端的环境变量，然后执行：

```powershell
$env:DROPPING_SFTP_FIXTURE = '<启动输出中的 fixture.json 绝对路径>'
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib sftp_integration -- --ignored --nocapture
```

两台服务器分别提供 `/hello.txt`、1 MiB 的 `/payload.bin`、8 MiB 的 `/slow.bin`，以及包含普通文件、中文内容和空目录的 `/tree`。默认每次 SFTP 读写延迟 2 毫秒，便于验证取消和进度。

`fixture.json` 包含服务器端口、SHA256 主机指纹、测试凭据、客户端私钥路径，以及 `authLogPath` 和 `stopFile`。认证日志只记录认证方式、用户名与成功状态，方便确认错误主机指纹在提交凭据前被拒绝。按 Ctrl+C 或创建 `stopFile` 指定的空文件即可停止手动服务器；证据文件保留以供检查。
