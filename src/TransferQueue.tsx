import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeftRight, Check, CircleAlert, X } from 'lucide-react';
import { FileIcon, formatSize } from './files';
import type { TransferProgress } from './types';
import { useDismiss } from './useDismiss';

export type QueueItem = {
  id: string; name: string; isDir: boolean; sourceName: string; destinationName: string;
  sourceConnectionId: string; destinationConnectionId: string; sourcePath: string;
  destinationDirectory: string; status: 'queued' | TransferProgress['status'];
  bytesTransferred: number; totalBytes: number; filesTransferred: number; totalFiles: number;
  error?: string; currentFile: string;
};

const statusLabels: Record<QueueItem['status'], string> = { queued: '排队中', running: '正在传输', completed: '已完成', failed: '失败', cancelled: '已取消' };
const isPending = (item: QueueItem) => item.status === 'queued' || item.status === 'running';
const percentOf = (item: QueueItem) => item.totalBytes > 0 ? Math.min(100, Math.round(item.bytesTransferred / item.totalBytes * 100)) : item.status === 'completed' ? 100 : 0;

interface TransferQueueProps {
  items: QueueItem[];
  onCancel: (item: QueueItem) => void;
  onClearFinished: () => void;
}

export default function TransferQueue({ items, onCancel, onClearFinished }: TransferQueueProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);

  const pending = items.filter(isPending).length;
  const completed = items.filter(item => item.status === 'completed').length;
  const running = items.find(item => item.status === 'running');
  const ordered = [...items.filter(item => item.status === 'running'), ...items.filter(item => item.status === 'queued'), ...items.filter(item => !isPending(item)).reverse()];
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    triggerRef.current?.focus();
  };

  return (
    <div className="queue" ref={rootRef} onKeyDown={onKeyDown}>
      <button ref={triggerRef} className={`icon-btn tool-icon ${open ? 'is-on' : ''}`} onClick={() => setOpen(value => !value)} aria-label="传输队列" title="传输队列" aria-expanded={open} aria-haspopup="dialog">
        <ArrowLeftRight size={15} />{pending > 0 && <span className="badge">{pending}</span>}
        {running && <span className="tool-progress"><span className={running.totalBytes ? '' : 'indeterminate'} style={{ width: `${percentOf(running)}%` }} /></span>}
      </button>
      {open && (
        <section className="queue-panel" role="dialog" aria-label="传输队列">
          <div className="queue-head">
            <strong>传输队列</strong>
            <span className="muted">{pending > 0 ? `${pending} 项进行中` : items.length ? `${completed} 项完成` : ''}</span>
            {items.some(item => !isPending(item)) && <button className="link-btn" onClick={onClearFinished}>清除已结束</button>}
          </div>
          <div className="queue-body">
            {items.length === 0
              ? <div className="queue-empty"><strong>暂无任务</strong><span>双击文件，或选中后点击「传到右侧 / 左侧」。</span></div>
              : ordered.map(item => (
                <div className={`queue-row is-${item.status}`} key={item.id}>
                  <FileIcon entry={item} />
                  <div className="queue-main">
                    <div className="queue-line">
                      <span className="queue-name" title={item.sourcePath}>{item.name}</span>
                      <span className="queue-status">{statusLabels[item.status]}</span>
                    </div>
                    <span className="queue-route" title={`${item.sourcePath} → ${item.destinationDirectory}`}>{item.sourceName} → {item.destinationName}<span className="queue-target">{item.destinationDirectory}</span></span>
                    {item.status !== 'cancelled' && <div className="track"><div className={item.status === 'running' && !item.totalBytes ? 'indeterminate' : ''} style={{ width: `${percentOf(item)}%` }} /></div>}
                    {(item.status === 'running' || item.status === 'completed') && (
                      <span className="queue-meta">{item.status === 'running' ? `${formatSize(item.bytesTransferred)} / ${formatSize(item.totalBytes)}` : `${formatSize(item.bytesTransferred)} · ${item.filesTransferred} 个文件`}</span>
                    )}
                    {item.error && <span className="queue-error">{item.error}</span>}
                  </div>
                  <div className="queue-action">
                    {isPending(item)
                      ? <button className="icon-btn" aria-label={`取消 ${item.name}`} title="取消传输" onClick={() => onCancel(item)}><X size={13} /></button>
                      : item.status === 'completed' ? <Check size={14} /> : item.status === 'failed' ? <CircleAlert size={14} className="danger" /> : null}
                  </div>
                </div>
              ))}
          </div>
          <div className="queue-foot">复制到目标目录，同名项不覆盖</div>
        </section>
      )}
    </div>
  );
}
