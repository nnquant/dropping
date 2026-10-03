export interface Connection {
  id: string;
  name: string;
  kind: 'local' | 'ssh';
  host?: string | null;
  username?: string | null;
  home: string;
}

export interface HostKey { fingerprint: string; keyType: string }

export interface SshConfigHost {
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'key' | 'password';
  privateKeyPath: string | null;
  warning: string | null;
}

export interface SshConfigHosts {
  path: string;
  hosts: SshConfigHost[];
  warnings: string[];
}

export interface SshConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  fingerprint: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
}

export interface DirectoryListing { path: string; parent: string | null; entries: FileEntry[] }
export interface Preview {
  kind: 'text' | 'image' | 'unsupported';
  content: string;
  mime: string;
  truncated: boolean;
  size: number;
}

export interface TransferArgs {
  id: string;
  sourceConnectionId: string;
  destinationConnectionId: string;
  sourcePath: string;
  destinationDirectory: string;
}

export interface TransferProgress {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  bytesTransferred: number;
  totalBytes: number;
  filesTransferred: number;
  totalFiles: number;
  currentFile: string;
  error?: string;
}
export interface TransferResult { targetPath: string; bytes: number; files: number }
