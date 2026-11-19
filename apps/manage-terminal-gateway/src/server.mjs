import { createServer } from 'node:http';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Client } from 'ssh2';
import { WebSocketServer } from 'ws';

const secret = process.env.MANAGE_TERMINAL_GATEWAY_SECRET || '';
const configPath = process.env.MANAGE_TERMINAL_VMS_FILE || '';
const keyPath = process.env.MANAGE_TERMINAL_SSH_KEY_FILE || '';
if (secret.length < 32 || !configPath || !keyPath) throw new Error('Gateway requires shared secret, VM allowlist file and SSH private key file');
const targets = JSON.parse(readFileSync(configPath, 'utf8'));
if (!Array.isArray(targets)) throw new Error('VM allowlist must be an array');
const privateKey = readFileSync(keyPath);
const byId = new Map();
for (const vm of targets) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(vm.id) ||
      !/^[a-zA-Z0-9.-]{1,253}$/.test(vm.host) ||
      !Number.isInteger(vm.port) || vm.port < 1 || vm.port > 65535 ||
      !/^[a-z_][a-z0-9_-]{0,31}$/i.test(vm.username) ||
      !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(vm.hostKeySha256) || byId.has(vm.id))
    throw new Error('Invalid SSH allowlist entry');
  byId.set(vm.id, vm);
}
const usedTickets = new Map();
const active = new Map();
const MAX_CONNECTIONS = 3;
const MAX_FRAME_BYTES = 8192;
const IDLE_MS = 15 * 60_000;
function decodeTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts.every(x => /^[A-Za-z0-9_-]+$/.test(x))) return null;
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  const received = Buffer.from(parts[1], 'base64url');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  let value;
  try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (value.v !== 1 || value.aud !== 'rod-manage-terminal' ||
      !Number.isInteger(value.exp) || value.exp < now || value.exp > now + 30 ||
      typeof value.sub !== 'string' || !value.sub.includes('@') ||
      typeof value.jti !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.jti) ||
      !byId.has(value.targetId) || usedTickets.has(value.jti)) return null;
  usedTickets.set(value.jti, value.exp);
  return value;
}
const server = createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 256, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  const receivedSecret = request.headers['x-terminal-gateway-secret'];
  const provided = typeof receivedSecret === 'string' ? Buffer.from(receivedSecret) : Buffer.alloc(0);
  const trusted = Buffer.from(secret);
  if (request.url !== '/ws' || provided.length !== trusted.length || !timingSafeEqual(provided, trusted)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  const claims = decodeTicket(request.headers['x-terminal-ticket']);
  if (!claims || active.size >= MAX_CONNECTIONS || active.has(claims.jti)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, claims));
});
wss.on('connection', (ws, claims) => {
  const vm = byId.get(claims.targetId);
  const ssh = new Client();
  active.set(claims.jti, ssh);
  let stream;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let requestedSize = { cols: 80, rows: 24 };
  let lastActivity = Date.now();
  const send = frame => { if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 1024) ws.send(JSON.stringify(frame)); else if (ws.bufferedAmount >= 1024 * 1024) ws.close(1009, 'Backpressure'); };
  const close = () => { active.delete(claims.jti); stream?.close(); ssh.end(); };
  const sshTimeout = setTimeout(() => { send({ type: 'error', code: 'TIMEOUT', message: 'Tempo limite da sessão excedido' }); ws.close(); }, 12_000);
  sshTimeout.unref();
  const idle = setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) ws.close(1000, 'Idle timeout'); }, 15000);
  ws.on('close', () => { clearInterval(idle); clearTimeout(sshTimeout); close(); });
  ws.on('error', () => ws.close());
  ws.on('message', bytes => {
    lastActivity = Date.now();
    if (bytes.length > MAX_FRAME_BYTES + 256) return ws.close(1009);
    let frame;
    try { frame = JSON.parse(bytes.toString('utf8')); } catch { return ws.close(1002); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return ws.close(1002);
    if (frame.type === 'stdin' && Object.keys(frame).length === 2 &&
        typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= MAX_FRAME_BYTES) {
      if (stream) stream.write(frame.data);
    } else if (frame.type === 'resize' && Object.keys(frame).length === 3 &&
      Number.isInteger(frame.cols) && frame.cols >= 20 && frame.cols <= 500 &&
      Number.isInteger(frame.rows) && frame.rows >= 5 && frame.rows <= 200) {
      requestedSize = { rows: frame.rows, cols: frame.cols };
      stream?.setWindow(frame.rows, frame.cols, 0, 0);
    } else if (frame.type === 'ping' && Object.keys(frame).length === 1) send({ type: 'pong' });
    else ws.close(1002, 'Invalid frame');
  });
  ssh.on('ready', () => {
    clearTimeout(sshTimeout);
    ssh.shell({ term: 'xterm-256color', ...requestedSize }, (error, channel) => {
      if (error) { send({ type: 'error', code: 'SHELL', message: 'Falha ao abrir shell' }); ws.close(); return; }
      stream = channel;
      channel.setWindow(requestedSize.rows, requestedSize.cols, 0, 0);
      send({ type: 'ready' });
      channel.on('data', data => {
        lastActivity = Date.now();
        const output = stdoutDecoder.write(data);
        if (output) send({ type: 'stdout', data: output });
      });
      channel.stderr.on('data', data => {
        lastActivity = Date.now();
        const output = stderrDecoder.write(data);
        if (output) send({ type: 'stdout', data: output });
      });
      channel.on('close', code => {
        const trailing = stdoutDecoder.end() + stderrDecoder.end();
        if (trailing) send({ type: 'stdout', data: trailing });
        send({ type: 'exit', code: typeof code === 'number' ? code : null });
        ws.close();
      });
    });
  });
  ssh.on('error', () => { clearTimeout(sshTimeout); send({ type: 'error', code: 'SSH', message: 'Falha na conexão SSH' }); ws.close(); });
  const expected = vm.hostKeySha256.replace(/^SHA256:/, '').replace(/=+$/, '');
  ssh.connect({
    host: vm.host, port: vm.port, username: vm.username, privateKey,
    readyTimeout: 12000, keepaliveInterval: 15000,
    hostVerifier: key => createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === expected,
  });
});
setInterval(() => { const now = Date.now() / 1000; for (const [jti, exp] of usedTickets) if (exp < now) usedTickets.delete(jti); }, 30000).unref();
server.listen(Number(process.env.PORT || 8789), '127.0.0.1', () => console.log('Terminal SSH gateway listening on loopback'));
