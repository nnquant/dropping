"""Two isolated localhost SFTP servers for the real Rust transport tests.

Run with Python + paramiko, then set DROPPING_SFTP_FIXTURE to the printed
manifest path. All fixture files stay under this repository's work directory.
Create the manifest's stopFile, or send Ctrl+C, to stop both listeners.
"""

from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import json
import logging
import os
from pathlib import Path
import posixpath
import signal
import socket
import threading
import time

import paramiko


REPO = Path(__file__).resolve().parents[1]
WORK = REPO / "work"
USERNAME = "dropping-test"
PASSWORD = "dropping-test-only"


def inside(path: Path, parent: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(parent.resolve()):
        raise ValueError(f"Fixture paths must stay inside {parent}")
    return resolved


def fingerprint(key: paramiko.PKey) -> str:
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


class Audit:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        path.write_text("", encoding="utf-8")

    def write(self, endpoint: str, event: str, **fields):
        item = {"time": time.time(), "endpoint": endpoint, "event": event, **fields}
        with self.lock, self.path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(item, ensure_ascii=False) + "\n")


class Authentication(paramiko.ServerInterface):
    def __init__(self, endpoint: str, client_key: paramiko.PKey, audit: Audit):
        self.endpoint = endpoint
        self.client_key = client_key
        self.audit = audit

    def get_allowed_auths(self, username):
        return "password,publickey"

    def check_auth_none(self, username):
        self.audit.write(self.endpoint, "auth", method="none", username=username, accepted=False)
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        accepted = username == USERNAME and password == PASSWORD
        self.audit.write(self.endpoint, "auth", method="password", username=username, accepted=accepted)
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def check_auth_publickey(self, username, key):
        accepted = username == USERNAME and key.asbytes() == self.client_key.asbytes()
        self.audit.write(self.endpoint, "auth", method="publickey", username=username, accepted=accepted)
        return paramiko.AUTH_SUCCESSFUL if accepted else paramiko.AUTH_FAILED

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED


class FileHandle(paramiko.SFTPHandle):
    def __init__(self, flags: int, local: Path, stream, delay: float):
        super().__init__(flags)
        self.local = local
        self.stream = stream
        self.delay = delay
        if flags & os.O_RDWR:
            self.readfile = self.writefile = stream
        elif flags & os.O_WRONLY:
            self.writefile = stream
        else:
            self.readfile = stream

    def close(self):
        self.stream.close()
        return paramiko.SFTP_OK

    def stat(self):
        try:
            return paramiko.SFTPAttributes.from_stat(os.fstat(self.stream.fileno()))
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def chattr(self, attr):
        try:
            paramiko.SFTPServer.set_file_attr(str(self.local), attr)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def read(self, offset, length):
        if self.delay:
            time.sleep(self.delay)
        return super().read(offset, length)

    def write(self, offset, data):
        if self.delay:
            time.sleep(self.delay)
        return super().write(offset, data)


class FileSystem(paramiko.SFTPServerInterface):
    def __init__(self, server, *, root: Path, delay: float, **kwargs):
        super().__init__(server, **kwargs)
        self.root = root.resolve()
        self.delay = delay

    def canonicalize(self, path):
        return posixpath.normpath("/" + path.lstrip("/"))

    def local(self, path: str, mutable: bool = False) -> Path:
        if "\\" in path or ":" in path or "\0" in path:
            raise OSError(errno.EACCES, "Invalid virtual path")
        local = self.root.joinpath(self.canonicalize(path).lstrip("/")).resolve()
        if not local.is_relative_to(self.root) or (mutable and local == self.root):
            raise OSError(errno.EACCES, "Outside fixture root")
        return local

    def list_folder(self, path):
        try:
            return [paramiko.SFTPAttributes.from_stat(child.lstat(), child.name) for child in self.local(path).iterdir()]
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(path).stat())
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def lstat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(path).lstat())
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def open(self, path, flags, attr):
        try:
            writable = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
            local = self.local(path, mutable=writable)
            descriptor = os.open(local, flags | getattr(os, "O_BINARY", 0), 0o666)
            mode = "r+b" if flags & os.O_RDWR else "wb" if flags & os.O_WRONLY else "rb"
            stream = os.fdopen(descriptor, mode, buffering=0)
            return FileHandle(flags, local, stream, self.delay)
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def remove(self, path):
        try:
            self.local(path, mutable=True).unlink()
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def rename(self, oldpath, newpath):
        try:
            source = self.local(oldpath, mutable=True)
            destination = self.local(newpath, mutable=True)
            if destination.exists():
                return paramiko.SFTP_FAILURE
            source.rename(destination)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def posix_rename(self, oldpath, newpath):
        try:
            self.local(oldpath, mutable=True).replace(self.local(newpath, mutable=True))
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def mkdir(self, path, attr):
        try:
            self.local(path, mutable=True).mkdir(mode=0o777)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def rmdir(self, path):
        try:
            self.local(path, mutable=True).rmdir()
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)

    def chattr(self, path, attr):
        try:
            paramiko.SFTPServer.set_file_attr(str(self.local(path, mutable=True)), attr)
            return paramiko.SFTP_OK
        except OSError as exc:
            return paramiko.SFTPServer.convert_errno(exc.errno)


class Endpoint:
    def __init__(self, name: str, root: Path, host_key, client_key, audit: Audit, stop, delay: float):
        self.name, self.root, self.host_key = name, root, host_key
        self.client_key, self.audit, self.stop, self.delay = client_key, audit, stop, delay
        self.transports = []
        self.lock = threading.Lock()
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(16)
        self.listener.settimeout(0.25)
        self.port = self.listener.getsockname()[1]

    def start(self):
        threading.Thread(target=self.accept, name=f"sftp-{self.name}", daemon=True).start()

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self.serve, args=(client,), daemon=True).start()

    def serve(self, client):
        transport = paramiko.Transport(client)
        with self.lock:
            self.transports.append(transport)
        try:
            transport.add_server_key(self.host_key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, FileSystem, root=self.root, delay=self.delay)
            transport.start_server(server=Authentication(self.name, self.client_key, self.audit))
            while transport.is_active() and not self.stop.wait(0.1):
                pass
        except (EOFError, OSError, paramiko.SSHException) as exc:
            logging.getLogger("fixture").warning("%s disconnected: %s", self.name, type(exc).__name__)
        finally:
            transport.close()
            with self.lock:
                self.transports.remove(transport)

    def close(self):
        self.listener.close()
        with self.lock:
            for transport in self.transports:
                transport.close()


def seed(root: Path, label: str):
    root.mkdir(mode=0o777, parents=True)
    (root / "hello.txt").write_text(f"Dropping {label}\n你好，跨设备传输。\n", encoding="utf-8")
    (root / "payload.bin").write_bytes(bytes(range(256)) * 4096)
    (root / "slow.bin").write_bytes(bytes(range(256)) * 32768)
    (root / "tree" / "nested").mkdir(mode=0o777, parents=True)
    (root / "tree" / "empty").mkdir(mode=0o777)
    (root / "tree" / "nested" / "result.csv").write_text("symbol,pnl\n测试,12.5\n", encoding="utf-8")
    (root / "tree" / "summary.json").write_text('{"ok":true,"value":42}\n', encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-dir", type=Path, help="New fixture directory beneath repository work/")
    parser.add_argument("--io-delay", type=float, default=0.002, help="Seconds per SFTP read/write for observable cancellation")
    args = parser.parse_args()
    if not 0 <= args.io_delay <= 1:
        parser.error("--io-delay must be between 0 and 1 second")
    WORK.mkdir(mode=0o777, exist_ok=True)
    base = inside(args.base_dir or WORK / f"sftp-fixture-{time.time_ns()}-{os.getpid()}", WORK)
    base.mkdir(mode=0o777)
    logging.basicConfig(filename=base / "paramiko.log", level=logging.WARNING, encoding="utf-8")
    stop = threading.Event()
    stop_file = base / "STOP"
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    audit = Audit(base / "auth.jsonl")
    client_key = paramiko.RSAKey.generate(2048)
    private_key_path = base / "client_key.pem"
    client_key.write_private_key_file(str(private_key_path))
    endpoints = []
    for name in ("alpha", "beta"):
        root = base / name
        seed(root, name)
        endpoint = Endpoint(name, root, paramiko.RSAKey.generate(2048), client_key, audit, stop, args.io_delay)
        endpoint.start()
        endpoints.append(endpoint)
    local_root = base / "local"
    local_root.mkdir(mode=0o777)
    manifest = {
        "pid": os.getpid(),
        "username": USERNAME,
        "password": PASSWORD,
        "privateKeyPath": str(private_key_path),
        "authLogPath": str(audit.path),
        "localRoot": str(local_root),
        "stopFile": str(stop_file),
        "endpoints": [
            {"name": e.name, "host": "127.0.0.1", "port": e.port, "fingerprint": fingerprint(e.host_key), "root": str(e.root)}
            for e in endpoints
        ],
    }
    manifest_path = base / "fixture.json"
    pending_manifest = base / "fixture.pending.json"
    pending_manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    pending_manifest.replace(manifest_path)
    print(json.dumps({"manifest": str(manifest_path), **manifest}, ensure_ascii=False), flush=True)
    try:
        while not stop.wait(0.25):
            if stop_file.exists():
                break
    finally:
        stop.set()
        for endpoint in endpoints:
            endpoint.close()
        print("SFTP fixture stopped; evidence preserved at " + str(base), flush=True)


if __name__ == "__main__":
    main()
