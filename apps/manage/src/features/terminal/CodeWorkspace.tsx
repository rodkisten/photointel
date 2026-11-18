import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { languages } from '@codemirror/language-data';
import { persistWorkspace, restoreWorkspace, type WorkspaceDocument } from './workspace-db';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { FilePlus2, Save, X, FileCode2 } from 'lucide-react';

type Document = WorkspaceDocument;
const initial = (targetId: string): Document[] => [{ id: crypto.randomUUID(), targetId, name: 'scratch.txt', content: '', saved: '', updatedAt: Date.now() }];

/**
 * CodeMirror scratch workspace. Remote file operations MUST be implemented by the
 * authenticated gateway before exposing Open/Save for server paths.
 * No SSH credentials or file contents are persisted in browser storage.
 */
export function CodeWorkspace({ targetId }: { targetId: string }) {
  const [documents, setDocuments] = useState<Document[]>(() => initial(targetId));
  const [activeId, setActiveId] = useState(documents[0].id);
  const [restored, setRestored] = useState(false);
  const [storageStatus, setStorageStatus] = useState('Carregando sessão local…');
  const [busy, setBusy] = useState(false);
  const [remotePath, setRemotePath] = useState('/home/');
  const [entries, setEntries] = useState<{ name: string; kind: 'file' | 'directory' }[]>([]);
  const [directory, setDirectory] = useState('/home/');
  const [message, setMessage] = useState('Rascunhos locais nesta sessão. Arquivos remotos ainda não estão conectados.');
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = documents.find(doc => doc.id === activeId) ?? documents[0];
  const update = (id: string, content: string) => setDocuments(items => items.map(doc => doc.id === id ? { ...doc, content, updatedAt: Date.now() } : doc));
  useEffect(() => {
    let cancelled = false;
    void restoreWorkspace(targetId).then(({ documents: stored, session }) => {
      if (cancelled) return;
      const next = stored.length ? stored : initial(targetId);
      setDocuments(next);
      setActiveId(session && next.some(doc => doc.id === session.activeId) ? session.activeId : next[0].id);
      if (session?.remotePath) setRemotePath(session.remotePath);
      setStorageStatus('Sessão recuperada do IndexedDB');
      setRestored(true);
    }).catch(() => {
      if (cancelled) return;
      setStorageStatus('IndexedDB indisponível: alterações não serão persistidas');
      setRestored(false);
    });
    return () => { cancelled = true; };
  }, [targetId]);
  useEffect(() => {
    if (!restored) return;
    const handle = window.setTimeout(() => {
      void persistWorkspace(targetId, documents, activeId, remotePath)
        .then(() => setStorageStatus('Alterações locais protegidas no IndexedDB'))
        .catch(() => setStorageStatus('Falha ao salvar no IndexedDB'));
    }, 350);
    return () => window.clearTimeout(handle);
  }, [targetId, documents, activeId, remotePath, restored]);
  useEffect(() => {
    const element = mount.current;
    if (!element || !current) return;
    const id = current.id;
    const language = new Compartment();
    let disposed = false;
    const editor = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: current.content,
        extensions: [
          lineNumbers(), highlightActiveLine(), drawSelection(), history(), language.of([]),
          indentOnInput(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', fontSize: '14px', backgroundColor: '#090d13', color: '#e5e7eb' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            '.cm-gutters': { backgroundColor: '#101722', color: '#64748b', border: 'none' },
            '.cm-activeLine': { backgroundColor: '#ffffff0a' },
            '.cm-cursor': { borderLeftColor: '#a78bfa' },
            '.cm-content': { padding: '12px 0', minHeight: '280px' },
          }),
          EditorView.updateListener.of(updateEvent => {
            if (updateEvent.docChanged) update(id, updateEvent.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    const description = languages.find(item => item.matchFilename(current.path || current.name));
    if (description) {
      void description.load().then(support => {
        if (!disposed) editor.dispatch({ effects: language.reconfigure(support) });
      }).catch(() => setMessage('Não foi possível carregar o destaque de sintaxe para ' + current.name));
    }
    return () => { disposed = true; editor.destroy(); if (view.current === editor) view.current = null; };
    // Switching tabs remounts from React state. Content edits never remount the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, targetId]);

  const add = () => {
    const name = window.prompt('Nome do rascunho (não é um caminho remoto):', 'untitled.txt');
    if (!name) return;
    const safeName = name.trim().slice(0, 100);
    if (!safeName || safeName.includes('/') || safeName.includes('\\\\') || [...safeName].some(char => char.charCodeAt(0) < 32)) { setMessage('Nome de arquivo inválido'); return; }
    const doc: Document = { id: crypto.randomUUID(), targetId, name: safeName, content: '', saved: '', updatedAt: Date.now() };
    setDocuments(items => [...items, doc]);
    setActiveId(doc.id);
  };
  const close = (id: string) => {
    const doc = documents.find(item => item.id === id);
    if (!doc || (doc.content !== doc.saved && !window.confirm('Descartar alterações deste rascunho?'))) return;
    const remaining = documents.filter(item => item.id !== id);
    if (!remaining.length) {
      const replacement = initial(targetId);
      setDocuments(replacement);
      setActiveId(replacement[0].id);
    } else {
      setDocuments(remaining);
      if (activeId === id) setActiveId(remaining[0].id);
    }
  };
  const remote = async (operation: 'list' | 'read' | 'write', path: string, document?: Document) => {
    if (targetId === 'scratch') { setMessage('Selecione uma VM antes de acessar arquivos remotos.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/terminal/files', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, targetId, path,
          ...(operation === 'write' && document ? { content: document.content, version: document.version } : {}) }),
      });
      const payload = await response.json() as { entries?: { name: string; kind: 'file' | 'directory' }[];
        content?: string; version?: string; message?: string };
      if (!response.ok) throw new Error(payload.message || 'Operação remota indisponível');
      if (operation === 'list' && payload.entries) {
        setEntries(payload.entries);
        setDirectory(path.endsWith('/') ? path : path + '/');
        setRemotePath(path);
        setMessage(payload.entries.length + ' itens encontrados.');
      }
      if (operation === 'read' && typeof payload.content === 'string' && payload.version) {
        const existing = documents.find(item => item.path === path);
        if (existing) {
          if (existing.content !== existing.saved) {
            setActiveId(existing.id);
            setMessage('Arquivo já aberto com alterações locais. Salve ou descarte antes de recarregar.');
            return;
          }
          setDocuments(items => items.map(item => item.id === existing.id ?
            { ...item, content: payload.content!, saved: payload.content!, version: payload.version, updatedAt: Date.now() } : item));
          setActiveId(existing.id);
        } else {
          const doc: Document = { id: crypto.randomUUID(), name: path.split('/').pop() || path,
            path, targetId, content: payload.content, saved: payload.content, version: payload.version, updatedAt: Date.now() };
          setDocuments(items => [...items, doc]);
          setActiveId(doc.id);
        }
        setMessage('Arquivo remoto aberto: ' + path);
      }
      if (operation === 'write' && document && payload.version) {
        setDocuments(items => items.map(item => item.id === document.id ?
          { ...item, saved: document.content, version: payload.version, updatedAt: Date.now() } : item));
        setMessage('Arquivo salvo na VM: ' + path);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha no acesso remoto');
    } finally { setBusy(false); }
  };
  const openPath = () => {
    const path = remotePath.trim();
    if (!path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.')) {
      setMessage('Informe um caminho absoluto válido.'); return;
    }
    void remote(path.endsWith('/') ? 'list' : 'read', path);
  };
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = current.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Download does not acknowledge a remote save or discard pending changes.
    setMessage('Arquivo baixado no dispositivo. Nenhuma alteração foi enviada à VM.');
  };
  return <div className="flex min-h-[420px] min-w-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 border-b border-carbon-800 p-2">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Arquivos abertos">
        {documents.map(doc => <div key={doc.id} className={'flex shrink-0 items-center rounded-lg border text-xs ' + (doc.id === activeId ? 'border-violet-500 bg-carbon-800 text-carbon-100' : 'border-transparent text-carbon-400')}>
          <button type="button" role="tab" aria-selected={doc.id === activeId} onClick={() => setActiveId(doc.id)} className="flex min-h-10 items-center gap-1 px-3">
            <FileCode2 size={13}/>{doc.name}{doc.content !== doc.saved && <span aria-label="Alterado" className="text-violet-400">●</span>}
          </button>
          <button type="button" aria-label={'Fechar ' + doc.name} onClick={() => close(doc.id)} className="min-h-10 px-2"><X size={13}/></button>
        </div>)}
      </div>
      <div className="flex shrink-0 gap-1">
        <button type="button" onClick={add} aria-label="Novo rascunho" title="Novo rascunho" className="rounded-lg border border-carbon-700 p-2"><FilePlus2 size={16}/></button>
        <button type="button" onClick={download} aria-label="Baixar arquivo" title="Baixar arquivo localmente" className="rounded-lg border border-carbon-700 p-2"><Save size={16}/></button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2 border-b border-carbon-800 p-2">
      <input aria-label="Caminho remoto" value={remotePath} onChange={event => setRemotePath(event.target.value)}
        className="min-h-10 min-w-0 flex-1 rounded-lg border border-carbon-700 bg-carbon-900 px-3 text-base text-carbon-100"
        placeholder="/home/user/code/" />
      <button type="button" disabled={busy} onClick={openPath} className="min-h-10 rounded-lg border border-carbon-700 px-3 text-sm disabled:opacity-40">Abrir</button>
      <button type="button" disabled={busy || !current?.path || current.content === current.saved}
        onClick={() => current?.path && void remote('write', current.path, current)}
        className="min-h-10 rounded-lg border border-violet-700 px-3 text-sm disabled:opacity-40">Salvar na VM</button>
    </div>
    {entries.length > 0 && <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto border-b border-carbon-800 p-2" aria-label="Arquivos remotos">
       <button type="button" disabled={busy} onClick={() => void remote('list', directory.replace(/\/?[^/]+\/?$/, '/') || '/')}
        className="rounded-lg border border-carbon-700 px-2 py-1 text-xs">..</button>
      {entries.map(entry => <button type="button" key={entry.name} disabled={busy}
        onClick={() => void remote(entry.kind === 'directory' ? 'list' : 'read',
          directory + entry.name + (entry.kind === 'directory' ? '/' : ''))}
        className="rounded-lg border border-carbon-700 px-2 py-1 text-xs">{entry.kind === 'directory' ? '📁 ' : '📄 '}{entry.name}</button>)}
    </div>}
    <div ref={mount} className="min-h-[300px] min-w-0 flex-1 overflow-hidden" aria-label="Editor CodeMirror 6"/>
    <p role="status" className="border-t border-carbon-800 px-3 py-2 text-xs text-carbon-400">{message} · {storageStatus}</p>
  </div>;
}
