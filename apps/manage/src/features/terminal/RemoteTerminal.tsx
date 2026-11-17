import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, useTerminal } from '@wterm/react';
import { GhosttyCore } from '@wterm/ghostty';
import '@wterm/react/css';

type Status = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';
type Frame = { type: 'stdout'; data: string } | { type: 'error'; message: string } | { type: 'exit'; code: number | null } | { type: 'pong' };

/** Single-use, short-lived session. No automatic input replay or reconnect. */
export function RemoteTerminal({ targetId }: { targetId: string }) {
  const { ref, write, focus } = useTerminal();
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    let disposed = false;
    let instance: GhosttyCore | undefined;
    void GhosttyCore.load().then(loaded => {
      instance = loaded;
      if (disposed) loaded.dispose(); else setCore(loaded);
    }).catch(() => setNotice('Não foi possível carregar o núcleo Ghostty'));
    return () => { disposed = true; instance?.dispose(); };
  }, []);
  const socket = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [notice, setNotice] = useState('');
  const send = useCallback((frame: object) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 65536) ws.send(JSON.stringify(frame));
  }, []);
  const connect = useCallback(async () => {
    if (socket.current || pending.current) return;
    pending.current = true;
    setStatus('connecting');
    setNotice('');
    try {
      const response = await fetch('/api/terminal/ticket', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }),
      });
      const result = await response.json() as { ticket?: string; message?: string };
      if (!response.ok || !result.ticket) throw new Error(result.message || 'Sessão não autorizada');
      const url = new URL('/api/terminal/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', result.ticket);
      const ws = new WebSocket(url);
      socket.current = ws;
      pending.current = false;
      ws.onopen = () => { setStatus('connected'); focus(); };
      ws.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 131072) { ws.close(1009); return; }
        let frame: Frame;
        try { frame = JSON.parse(event.data) as Frame; } catch { ws.close(1002); return; }
        if (frame.type === 'stdout' && typeof frame.data === 'string') write(frame.data);
        if (frame.type === 'error') setNotice(frame.message);
        if (frame.type === 'exit') { setNotice('Shell encerrado'); ws.close(); }
      };
      ws.onerror = () => { setStatus('error'); setNotice('Falha na conexão WebSocket'); };
      ws.onclose = () => { socket.current = null; setStatus(current => current === 'error' ? current : 'closed'); };
    } catch (error) {
      pending.current = false;
      setStatus('error');
      setNotice(error instanceof Error ? error.message : 'Falha ao iniciar sessão');
    }
  }, [targetId, focus, write]);
  useEffect(() => () => { pending.current = false; socket.current?.close(1000, 'Unmount'); socket.current = null; }, [targetId]);
  return (
    <div className="flex h-full min-h-[380px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-carbon-800 px-3 py-2 text-xs text-carbon-400">
        <span role="status">{status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Conectando…' : 'Desconectado'}</span>
        <button type="button" onClick={() => void connect()} disabled={status === 'connecting' || status === 'connected'} className="rounded-lg border border-carbon-700 px-3 py-2 disabled:opacity-40">Conectar</button>
        <button type="button" onClick={() => { socket.current?.close(); socket.current = null; setStatus('closed'); }} disabled={status !== 'connected'} className="rounded-lg border border-carbon-700 px-3 py-2 disabled:opacity-40">Desconectar</button>
        <button type="button" onClick={() => focus()} className="rounded-lg border border-carbon-700 px-3 py-2">Teclado</button>
      </div>
      {notice && <p role="alert" className="px-3 py-2 text-xs text-amber-400">{notice}</p>}
      {core ? <Terminal core={core} ref={ref} className="min-h-[320px] flex-1 overflow-hidden p-2" autoResize
        onData={data => send({ type: 'stdin', data })}
        onResize={(cols, rows) => send({ type: 'resize', cols, rows })}
        onError={() => setNotice('Falha ao inicializar WTerm')} /> : <div className="p-4 text-sm text-carbon-400">Carregando Ghostty…</div>}
      <div className="flex flex-wrap gap-1 border-t border-carbon-800 p-2 sm:hidden">
        {([['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B']] as const).map(([label, sequence]) =>
          <button type="button" key={label} className="min-h-11 rounded-lg border border-carbon-700 px-3 text-sm" onClick={() => { send({ type: 'stdin', data: sequence }); focus(); }}>{label}</button>)}
      </div>
    </div>
  );
}
