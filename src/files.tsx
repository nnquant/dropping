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

/** Candy palette shared by every file badge. */
const candy = {
  pink: '#ff9cc2', coral: '#ff8f8f', peach: '#ffb27d', amber: '#ffcb6b', lemon: '#ffe066', mint: '#7eddb0',
  aqua: '#6fd6e0', sky: '#8cc4ff', blue: '#7fa6ff', lavender: '#b9a3ff', grape: '#d49cff', gray: '#d5d7de',
};
type FileKind = { label: string; color: string };
const kinds: Record<string, FileKind> = {};
const define = (color: string, entries: Record<string, string>) => {
  for (const [extensions, label] of Object.entries(entries)) for (const extension of extensions.split(' ')) kinds[extension] = { label, color };
};
// Code
define(candy.sky, { py: 'PY', pyi: 'PY', ipynb: 'NB' });
define(candy.lemon, { js: 'JS', mjs: 'JS', cjs: 'JS', json: '{ }', jsonc: '{ }' });
define(candy.blue, { ts: 'TS', mts: 'TS', cts: 'TS', go: 'GO', dart: 'DT' });
define(candy.aqua, { tsx: 'TSX', jsx: 'JSX', vue: 'VUE', svelte: 'SV' });
define(candy.peach, { rs: 'RS', java: 'JV', kt: 'KT', swift: 'SW', scala: 'SC' });
define(candy.lavender, { c: 'C', h: 'H', cpp: 'C++', cc: 'C++', hpp: 'H++', cs: 'C#', md: 'MD', markdown: 'MD', mdx: 'MDX', rst: 'RST' });
define(candy.mint, { sh: 'SH', bash: 'SH', zsh: 'SH', fish: 'SH', ps1: 'PS', bat: 'BAT', cmd: 'CMD', csv: 'CSV', tsv: 'TSV', xls: 'XLS', xlsx: 'XLS', parquet: 'PQ', feather: 'FTH' });
define(candy.coral, { html: '< >', htm: '< >', rb: 'RB', pdf: 'PDF', toml: 'TML', lua: 'LUA' });
define(candy.pink, { css: 'CSS', scss: 'CSS', less: 'CSS', yaml: 'YML', yml: 'YML', png: 'PNG', jpg: 'JPG', jpeg: 'JPG', gif: 'GIF', webp: 'WEB', svg: 'SVG', bmp: 'BMP', ico: 'ICO', avif: 'AVF', heic: 'HEI' });
define(candy.grape, { r: 'R', jl: 'JL', php: 'PHP', sql: 'SQL', db: 'DB', sqlite: 'DB', mp3: 'MP3', wav: 'WAV', flac: 'FLC', mp4: 'MP4', mov: 'MOV', mkv: 'MKV', avi: 'AVI' });
define(candy.amber, { zip: 'ZIP', gz: 'GZ', tgz: 'TGZ', tar: 'TAR', '7z': '7Z', rar: 'RAR', zst: 'ZST', xz: 'XZ', bz2: 'BZ2', deb: 'DEB', rpm: 'RPM', whl: 'WHL', jar: 'JAR' });
define(candy.blue, { doc: 'DOC', docx: 'DOC', ppt: 'PPT', pptx: 'PPT', key: 'KEY' });
define(candy.aqua, { bin: 'BIN', pt: 'PT', pth: 'PT', ckpt: 'CK', safetensors: 'ST', onnx: 'NNX', h5: 'H5', pkl: 'PKL', pickle: 'PKL', npy: 'NPY', npz: 'NPZ' });
define(candy.gray, { txt: 'TXT', log: 'LOG', ini: 'INI', cfg: 'CFG', conf: 'CFG', env: 'ENV', lock: 'LCK', xml: 'XML', exe: 'EXE', msi: 'MSI', dll: 'DLL', so: 'SO', dmg: 'DMG', iso: 'ISO' });
const named: Record<string, FileKind> = {
  dockerfile: { label: 'DKR', color: candy.sky }, makefile: { label: 'MK', color: candy.peach },
  '.gitignore': { label: 'GIT', color: candy.coral }, '.gitattributes': { label: 'GIT', color: candy.coral },
  '.env': { label: 'ENV', color: candy.gray }, license: { label: 'LIC', color: candy.gray },
};

function kindOf(name: string): FileKind {
  const lower = name.toLowerCase();
  if (named[lower]) return named[lower];
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : '';
  return kinds[extension] || { label: extension.length > 0 && extension.length <= 3 ? extension.toUpperCase() : '', color: candy.gray };
}

export function FileIcon({ entry, size = 18 }: { entry: Pick<FileEntry, 'isDir' | 'name'>; size?: number }) {
  const className = `file-icon${entry.name.startsWith('.') ? ' is-dotfile' : ''}`;
  if (entry.isDir) {
    return (
      <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.25 3.5c0-.69.56-1.25 1.25-1.25h3.4c.35 0 .68.15.92.4l1.18 1.27h5.5c.69 0 1.25.56 1.25 1.25V6H1.25z" fill="#f2b23e" />
        <path d="M1.25 5.4h13.5v7.35c0 .69-.56 1.25-1.25 1.25h-11c-.69 0-1.25-.56-1.25-1.25z" fill="#ffcf5c" />
      </svg>
    );
  }
  const { label, color } = kindOf(entry.name);
  const fontSize = label.length >= 3 ? 5.1 : label.length === 2 ? 6 : 7.2;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5.75H10L14 4.75V14c0 .69-.56 1.25-1.25 1.25H3.5c-.69 0-1.25-.56-1.25-1.25V2c0-.69.56-1.25 1.25-1.25z" fill={color} />
      <path d="M10 .75V3.5c0 .69.56 1.25 1.25 1.25H14z" fill="#fff" fillOpacity=".55" />
      {label && <text x="8.1" y="13" textAnchor="middle" fontSize={fontSize} fontWeight="750" fill="#1f1f1f" fillOpacity=".8" style={{ fontFamily: 'var(--sans)', letterSpacing: '-.04em' }}>{label}</text>}
    </svg>
  );
}
