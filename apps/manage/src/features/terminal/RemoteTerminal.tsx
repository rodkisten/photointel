import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, useTerminal } from '@wterm/react';
import { GhosttyCore } from '@wterm/ghostty';
import '@wterm/react/css';

type Status = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
type Frame = { type: 'ready' } | { type: 'stdout'; data: string } | { type: 'error'; message: string } | { type: 'exit'; code: number | null } | { type: 'pong' };

/** Single-use, short-lived session. No automatic input replay or reconnect. */
export function RemoteTerminal({ targetId }: { targetId: string }) {
  const { ref, write, focus } = useTerminal();
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const dimensions = useRef({ cols: 80, rows: 24 });
  const [ctrl, setCtrl] = useState(false);
  useEffect(() => {
    let disposed = false;
    let instance: GhosttyCore | undefined;
    void GhosttyCore.load().then(loaded => {
      instance = loaded;
      if (disposed) loaded.dispose(); else setCore(loaded);
    }).catch(() => { if (!disposed) setNotice('Não foi possível carregar o núcleo Ghostty'); });
    return () => { disposed = true; instance?.dispose(); };
  }, []);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [notice, setNotice] = useState('');
  const send = useCallback((frame: object) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536 &&
        (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'resize' || status === 'connected'))
      ws.send(JSON.stringify(frame));
  }, [status]);
  const connect = useCallback(async () => {
    if (socket.current || pending.current) return;
    pending.current = true;
    const attempt = ++generation.current;
    setStatus('connecting');
    setNotice('');
    try {
      const response = await fetch('/api/terminal/ticket', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }),
      });
      const result = await response.json() as { ticket?: string; message?: string };
      if (attempt !== generation.current) return;
      if (!response.ok || !result.ticket) throw new Error(result.message || 'Sessão não autorizada');
      const url = new URL('/api/terminal/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', result.ticket);
      const ws = new WebSocket(url);
      socket.current = ws;
      pending.current = false;
      ws.onopen = () => {
        if (attempt !== generation.current) { ws.close(); return; }
        ws.send(JSON.stringify({ type: 'resize', ...dimensions.current }));
        focus();
      };
      ws.onmessage = event => {
        if (attempt !== generation.current) return;
        if (typeof event.data !== 'string' || event.data.length > 131072) { ws.close(1009); return; }
        let frame: Frame;
        try { frame = JSON.parse(event.data) as Frame; } catch { ws.close(1002); return; }
        if (frame.type === 'ready') { setStatus('connected'); focus(); }
        if (frame.type === 'stdout' && typeof frame.data === 'string') write(frame.data);
        if (frame.type === 'error') setNotice(frame.message);
        if (frame.type === 'exit') { setNotice('Shell encerrado'); ws.close(); }
      };
      ws.onerror = () => { if (attempt === generation.current) { setStatus('error'); setNotice('Falha na conexão WebSocket'); } };
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null;
        if (attempt === generation.current) setStatus(current => current === 'error' ? current : 'closed');
      };
    } catch (error) {
      if (attempt !== generation.current) return;
      pending.current = false;
      setStatus('error');
      setNotice(error instanceof Error ? error.message : 'Falha ao iniciar sessão');
    }
  }, [targetId, focus, write]);
  useEffect(() => () => {
    generation.current++;
    pending.current = false;
    socket.current?.close(1000, 'Unmount');
    socket.current = null;
  }, [targetId]);
  return (
    <div className="flex h-full min-h-[380px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-carbon-800 px-3 py-2 text-xs text-carbon-400">
        <span role="status">{status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Conectando…' : 'Desconectado'}</span>
        <button type="button" onClick={() => void connect()} disabled={status === 'connecting' || status === 'connected'} className="rounded-lg border border-carbon-700 px-3 py-2 disabled:opacity-40">Conectar</button>
        <button type="button" onClick={() => { generation.current++; pending.current = false; socket.current?.close(); socket.current = null; setStatus('closed'); }} disabled={status !== 'connected'} className="rounded-lg border border-carbon-700 px-3 py-2 disabled:opacity-40">Desconectar</button>
        <button type="button" onClick={() => focus()} className="rounded-lg border border-carbon-700 px-3 py-2">Teclado</button>
      </div>
      {notice && <p role="alert" className="px-3 py-2 text-xs text-amber-400">{notice}</p>}
      {core ? <Terminal core={core} ref={ref} className="min-h-[320px] flex-1 overflow-hidden p-2" autoResize
        onData={data => {
          if (status !== 'connected') return;
          if (ctrl) {
            const key = data.length === 1 ? data.toUpperCase().charCodeAt(0) : 0;
            send({ type: 'stdin', data: key >= 64 && key <= 95 ? String.fromCharCode(key - 64) : data });
            setCtrl(false);
          } else send({ type: 'stdin', data });
        }}
        onResize={(cols, rows) => { dimensions.current = { cols, rows }; send({ type: 'resize', cols, rows }); }}
        onError={() => setNotice('Falha ao inicializar WTerm')} /> : <div className="p-4 text-sm text-carbon-400">Carregando Ghostty…</div>}
      <div className="flex flex-wrap gap-1 border-t border-carbon-800 p-2 sm:hidden">
        <button type="button" aria-pressed={ctrl} disabled={status !== 'connected'}
          className={'min-h-11 rounded-lg border px-3 text-sm disabled:opacity-40 ' +
            (ctrl ? 'border-violet-400 bg-violet-500/20 text-violet-200' : 'border-carbon-700')}
          onClick={() => { setCtrl(value => !value); focus(); }}>Ctrl</button>
        {([['Esc', '\\x1b'], ['Tab', '\\t'], ['Ctrl+C', '\\x03'], ['Ctrl+D', '\\x04'],
          ['←', '\\x1b[D'], ['↑', '\\x1b[A'], ['↓', '\\x1b[B'], ['→', '\\x1b[C'],
          ['Home', '\\x1b[H'], ['End', '\\x1b[F'], ['PgUp', '\\x1b[5~'], ['PgDn', '\\x1b[6~']] as const).map(([label, sequence]) =>
          <button type="button" key={label} className="min-h-11 rounded-lg border border-carbon-700 px-3 text-sm disabled:opacity-40"
            disabled={status !== 'connected'} onClick={() => { send({ type: 'stdin', data: sequence }); setCtrl(false); focus(); }}>{label}</button>)}
      </div>
    </div>
  );
}
