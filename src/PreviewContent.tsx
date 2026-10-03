import { useMemo, type MouseEvent } from 'react';
import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatCell, isNumericColumn, type TablePreview } from './tables';

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);

/** Highlighting large previews would stall the UI, so they fall back to plain text. */
const HIGHLIGHT_LIMIT = 400_000;

const languages: Record<string, string> = {
  py: 'python', pyi: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', lua: 'lua', r: 'r', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql', pl: 'perl', mk: 'makefile', md: 'markdown', markdown: 'markdown', mdx: 'markdown',
};
const namedLanguages: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'makefile' };

export type PreviewFormat = 'markdown' | 'csv' | 'parquet' | 'code' | 'text';
const tableFormats: Record<string, PreviewFormat> = { csv: 'csv', tsv: 'csv', parquet: 'parquet' };
export function previewFormat(name: string): { format: PreviewFormat; language?: string } {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot > 0 ? lower.slice(dot + 1) : '';
  if (tableFormats[extension]) return { format: tableFormats[extension] };
  const language = namedLanguages[lower] || languages[extension];
  if (language === 'markdown') return { format: 'markdown', language };
  return language ? { format: 'code', language } : { format: 'text' };
}

function highlight(source: string, language: string | undefined) {
  if (!language || source.length > HIGHLIGHT_LIMIT || !hljs.getLanguage(language)) return null;
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

function CodeView({ source, language }: { source: string; language?: string }) {
  const html = useMemo(() => highlight(source, language), [source, language]);
  const lines = useMemo(() => {
    const count = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
    return Array.from({ length: Math.max(count, 1) }, (_, index) => index + 1).join('\n');
  }, [source]);
  return (
    <div className="code-view">
      <pre className="code-gutter" aria-hidden="true">{lines}</pre>
      {/* highlight.js escapes the source, so its markup is safe to inject. */}
      {html !== null
        ? <pre className="code-body"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>
        : <pre className="code-body"><code>{source}</code></pre>}
    </div>
  );
}

const keepInPlace = (event: MouseEvent) => event.preventDefault();
const markdownComponents: Components = {
  // Links must never navigate the app window; show the target on hover instead.
  a: ({ href, children }) => <a href={href} title={href} onClick={keepInPlace}>{children}</a>,
  code: ({ className, children }) => {
    const language = /language-([\w-]+)/.exec(className || '')?.[1];
    const html = language ? highlight(String(children).replace(/\n$/, ''), language) : null;
    return html !== null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code className={className}>{children}</code>;
  },
};

export function DataTable({ table }: { table: TablePreview }) {
  const numericColumns = useMemo(() => table.columns.map((_, column) => isNumericColumn(table.rows, column)), [table]);
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th className="data-index" aria-label="行号" />
            {table.columns.map((column, index) => <th key={index} className={numericColumns[index] ? 'is-number' : ''} title={column}>{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="data-index">{rowIndex + 1}</td>
              {table.columns.map((_, column) => {
                const value = row[column];
                const text = formatCell(value);
                const empty = value === null || value === undefined;
                return <td key={column} className={`${numericColumns[column] ? 'is-number' : ''}${empty ? ' is-null' : ''}`} title={text.length > 40 ? text : undefined}>{empty ? 'null' : text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length === 0 && <div className="list-state"><span className="muted">没有数据行</span></div>}
    </div>
  );
}

/** Renders text previews; tables are rendered by `DataTable`, so CSV here is its source view. */
export default function PreviewContent({ name, content, showSource }: { name: string; content: string; showSource: boolean }) {
  const { format, language } = previewFormat(name);
  if (format === 'csv') return <CodeView source={content} />;
  if (format === 'markdown' && !showSource) {
    return <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown></article>;
  }
  if (format === 'text') return <pre className="text-view"><code>{content}</code></pre>;
  return <CodeView source={content} language={language} />;
}
