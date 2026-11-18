import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { FilePlus2, Save, X, FileCode2 } from 'lucide-react';

type Document = { id: string; name: string; content: string; saved: string };
const initial = (): Document[] => [{ id: crypto.randomUUID(), name: 'scratch.txt', content: '', saved: '' }];

/**
 * CodeMirror scratch workspace. Remote file operations MUST be implemented by the
 * authenticated gateway before exposing Open/Save for server paths.
 * No SSH credentials or file contents are persisted in browser storage.
 */
export function CodeWorkspace({ targetId }: { targetId: string }) {
  const [documents, setDocuments] = useState<Document[]>(initial);
  const [activeId, setActiveId] = useState(documents[0].id);
  const [message, setMessage] = useState('Rascunhos locais nesta sessão. Arquivos remotos ainda não estão conectados.');
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = documents.find(doc => doc.id === activeId) ?? documents[0];
  const update = (id: string, content: string) => setDocuments(items => items.map(doc => doc.id === id ? { ...doc, content } : doc));
  useEffect(() => {
    const element = mount.current;
    if (!element || !current) return;
    const id = current.id;
    const editor = new EditorView({
      parent: element,
      state: EditorState.create({
        doc: current.content,
        extensions: [
          lineNumbers(), highlightActiveLine(), drawSelection(), history(),
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
    return () => { editor.destroy(); if (view.current === editor) view.current = null; };
    // Switching tabs remounts from React state. Content edits never remount the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, targetId]);

  const add = () => {
    const name = window.prompt('Nome do rascunho (não é um caminho remoto):', 'untitled.txt');
    if (!name) return;
    const safeName = name.trim().slice(0, 100);
    if (!safeName || safeName.includes('/') || safeName.includes('\\\\') || [...safeName].some(char => char.charCodeAt(0) < 32)) { setMessage('Nome de arquivo inválido'); return; }
    const doc = { id: crypto.randomUUID(), name: safeName, content: '', saved: '' };
    setDocuments(items => [...items, doc]);
    setActiveId(doc.id);
  };
  const close = (id: string) => {
    const doc = documents.find(item => item.id === id);
    if (!doc || (doc.content !== doc.saved && !window.confirm('Descartar alterações deste rascunho?'))) return;
    const remaining = documents.filter(item => item.id !== id);
    if (!remaining.length) {
      const replacement = initial();
      setDocuments(replacement);
      setActiveId(replacement[0].id);
    } else {
      setDocuments(remaining);
      if (activeId === id) setActiveId(remaining[0].id);
    }
  };
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = current.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDocuments(items => items.map(doc => doc.id === current.id ? { ...doc, saved: doc.content } : doc));
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
    <div ref={mount} className="min-h-[300px] min-w-0 flex-1 overflow-hidden" aria-label="Editor CodeMirror 6"/>
    <p role="status" className="border-t border-carbon-800 px-3 py-2 text-xs text-carbon-400">{message}</p>
  </div>;
}
