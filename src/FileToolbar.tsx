import { useRef, useState } from 'react';
import { ArrowDownAZ, Check, ClipboardPaste, Copy, Eye, EyeOff, FolderPlus, Home, Info, Link, List, MoreHorizontal, Pencil, Scissors, Trash2 } from 'lucide-react';
import { useDismiss } from './useDismiss';

type Props = {
  ready: boolean; selected: boolean; canPaste: boolean; busy: boolean; showHidden: boolean; compact: boolean;
  sort: 'name' | 'size' | 'modified'; ascending: boolean; clipboardName?: string;
  onNewFolder: () => void; onCut: () => void; onCopy: () => void; onPaste: () => void;
  onRename: () => void; onDelete: () => void; onCopyPath: () => void; onProperties: () => void;
  onHome: () => void; onHidden: () => void; onCompact: () => void;
  onSort: (sort: Props['sort'], ascending: boolean) => void;
};

export default function FileToolbar(props: Props) {
  const [open, setOpen] = useState<'sort' | 'more' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, !!open, () => setOpen(null));
  const run = (action: () => void) => { setOpen(null); action(); };
  const unavailable = !props.ready || props.busy;
  return (
    <div className="file-toolbar" role="group" aria-label="文件工具栏" ref={ref} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(null); event.stopPropagation(); }
    }}>
      <button className="icon-btn" aria-label="新建文件夹" title="新建文件夹 (Ctrl+Shift+N)" disabled={unavailable} onClick={props.onNewFolder}><FolderPlus size={14} /></button>
      <span className="tool-divider" />
      <button className="icon-btn" aria-label="剪切" title="剪切 (Ctrl+X)，同一设备内移动" disabled={unavailable || !props.selected} onClick={props.onCut}><Scissors size={14} /></button>
      <button className="icon-btn" aria-label="复制" title="复制 (Ctrl+C)" disabled={unavailable || !props.selected} onClick={props.onCopy}><Copy size={14} /></button>
      <button className="icon-btn" aria-label="粘贴" title={props.clipboardName ? `粘贴 ${props.clipboardName} (Ctrl+V)` : '粘贴 (Ctrl+V)'} disabled={unavailable || !props.canPaste} onClick={props.onPaste}><ClipboardPaste size={14} /></button>
      <button className="icon-btn" aria-label="重命名" title="重命名 (F2)" disabled={unavailable || !props.selected} onClick={props.onRename}><Pencil size={14} /></button>
      <button className="icon-btn delete-tool" aria-label="删除" title="删除 (Delete)" disabled={unavailable || !props.selected} onClick={props.onDelete}><Trash2 size={14} /></button>
      <span className="tool-divider" />
      <div className="tool-popover">
        <button className={`icon-btn ${open === 'sort' ? 'is-on' : ''}`} aria-label="排序方式" title="排序方式" aria-haspopup="true" aria-expanded={open === 'sort'} onClick={() => setOpen(open === 'sort' ? null : 'sort')}><ArrowDownAZ size={14} /></button>
        {open === 'sort' && <div className="file-tool-menu" role="group" aria-label="排序选项">
          {([{ key: 'name', label: '名称' }, { key: 'size', label: '大小' }, { key: 'modified', label: '修改时间' }] as const).map(item => (
            <button key={item.key} aria-pressed={props.sort === item.key} onClick={() => run(() => props.onSort(item.key, props.ascending))}><span>{item.label}</span>{props.sort === item.key && <Check size={13} />}</button>
          ))}
          <hr />
          <button aria-pressed={props.ascending} onClick={() => run(() => props.onSort(props.sort, true))}><span>升序</span>{props.ascending && <Check size={13} />}</button>
          <button aria-pressed={!props.ascending} onClick={() => run(() => props.onSort(props.sort, false))}><span>降序</span>{!props.ascending && <Check size={13} />}</button>
        </div>}
      </div>
      <button className={`icon-btn toggle-icon ${props.showHidden ? 'is-on' : ''}`} aria-label="显示隐藏文件" aria-pressed={props.showHidden} title={props.showHidden ? '隐藏点文件' : '显示隐藏文件'} onClick={props.onHidden}>{props.showHidden ? <Eye size={14} /> : <EyeOff size={14} />}</button>
      <div className="tool-popover">
        <button className={`icon-btn ${open === 'more' ? 'is-on' : ''}`} aria-label="更多文件操作" title="更多文件操作" aria-haspopup="true" aria-expanded={open === 'more'} onClick={() => setOpen(open === 'more' ? null : 'more')}><MoreHorizontal size={16} /></button>
        {open === 'more' && <div className="file-tool-menu" role="group" aria-label="更多操作">
          <button disabled={unavailable} onClick={() => run(props.onCopyPath)}><Link size={14} /><span>复制路径</span><kbd>Ctrl+Shift+C</kbd></button>
          <button disabled={unavailable || !props.selected} onClick={() => run(props.onProperties)}><Info size={14} /><span>属性</span><kbd>Alt+Enter</kbd></button>
          <hr />
          <button aria-pressed={props.compact} onClick={() => run(props.onCompact)}><List size={14} /><span>紧凑视图</span>{props.compact && <Check size={13} />}</button>
          <button disabled={unavailable} onClick={() => run(props.onHome)}><Home size={14} /><span>设备主目录</span></button>
        </div>}
      </div>
      {props.busy && <span className="sr-only">正在操作文件</span>}
    </div>
  );
}
