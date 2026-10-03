import { File, FileArchive, FileCode2, FileImage, FileText, Folder } from 'lucide-react';
import type { FileEntry } from './types';

export function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[index]}`;
}
export function formatDate(timestamp: number | null) {
  if (timestamp === null || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.valueOf()) ? '—' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function FileIcon({ entry, size = 15 }: { entry: Pick<FileEntry, 'isDir' | 'name'>; size?: number }) {
  const props = { size, strokeWidth: 1.6, className: entry.isDir ? 'file-icon folder-icon' : 'file-icon' };
  if (entry.isDir) return <Folder {...props} />;
  const extension = entry.name.split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(extension)) return <FileImage {...props} />;
  if (['zip', 'gz', 'tar', '7z', 'rar', 'zst'].includes(extension)) return <FileArchive {...props} />;
  if (['py', 'rs', 'js', 'ts', 'tsx', 'jsx', 'json', 'toml', 'yaml', 'yml', 'sh', 'html', 'css'].includes(extension)) return <FileCode2 {...props} />;
  if (['txt', 'md', 'csv', 'log', 'ini'].includes(extension)) return <FileText {...props} />;
  return <File {...props} />;
}
