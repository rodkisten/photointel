import { useState, type FormEvent } from 'react';
import { Apple, Check, Eye, EyeOff, KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, Input } from './ui';
import { send } from '../lib/client';

type ChallengeResponse = {
  state: 'verification_required';
  challenge: string;
  mode: '2fa' | '2sa';
  expires_in: number;
  message: string;
};
type SuccessResponse = {
  state: 'connected';
  valid: true;
  session_published: true;
  checked_at: string;
  library: string;
  message: string;
};
type AuthResponse = ChallengeResponse | SuccessResponse;

export function ICloudLoginForm({ onConnected }: { onConnected?: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [phase, setPhase] = useState<'password' | 'verify' | 'connected'>('password');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [library, setLibrary] = useState('');

  function reset() {
    setPassword('');
    setCode('');
    setChallenge('');
    setError('');
    setPhase('password');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const sendingCode = phase === 'verify';
    if (sendingCode && !/^\d{6}$/.test(code)) {
      setError('Digite os seis dígitos do código Apple.');
      return;
    }
    if (!sendingCode && !password) {
      setError('Informe sua senha do iCloud.');
      return;
    }
    // Read once and clear React state *before* the network request.
    // No credentials are placed in query strings, localStorage, persisted
    // React Query mutations, Cloudflare env, GitHub or browser telemetry.
    const body = sendingCode
      ? { challenge, code }
      : { password };
    setPassword('');
    setCode('');
    setError('');
    setPending(true);
    try {
      const result = sendingCode
        ? await send<AuthResponse>('/icloud/auth/verify', body)
        : await send<AuthResponse>('/icloud/auth/start', body);
      if (result.state === 'verification_required') {
        setChallenge(result.challenge);
        setPhase('verify');
      } else {
        setChallenge('');
        setLibrary(result.library);
        setPhase('connected');
        onConnected?.();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível autenticar. Tente novamente.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="space-y-4 border-slate-700 p-4" aria-label="Autenticação iCloud pelo navegador">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Apple size={20} className="shrink-0 text-slate-200" />
          <div>
            <h2 className="text-base font-semibold">Entrar na conta iCloud</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Renove sua sessão Apple aqui no Manage, sem abrir terminal.
            </p>
          </div>
        </div>
        <Badge tone={phase === 'connected' ? 'success' : 'neutral'}>
          {phase === 'connected' ? 'Conectado' : phase === 'verify' ? 'Verificar' : 'Seguro'}
        </Badge>
      </div>

      {phase === 'connected' ? (
        <div className="space-y-3" role="status">
          <p className="flex items-center gap-2 text-sm text-emerald-300">
            <ShieldCheck size={19} /> Sessão atualizada e acesso às fotos confirmado.
          </p>
          <p className="text-xs text-slate-400">
            Biblioteca: {library}. Os cookies são publicados criptografados apenas após validar o acesso.
          </p>
          <Button variant="outline" size="sm" type="button" onClick={reset}>
            <RotateCcw size={15} /> Entrar novamente
          </Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          {phase === 'password' ? (
            <div className="space-y-2">
              <label htmlFor="icloud-login-password" className="text-sm font-medium text-slate-200">
                Senha da Conta Apple
              </label>
              <div className="relative">
                <Input
                  id="icloud-login-password"
                  name="icloud-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Digite sua senha do iCloud"
                  maxLength={512}
                  required
                  className="pr-12 text-base"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  onClick={() => setShowPassword((old) => !old)}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <p className="text-xs leading-5 text-slate-500">
                A senha é enviada diretamente à API protegida do PhotoIntel e não é salva pelo Manage.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="icloud-login-code" className="text-sm font-medium text-slate-200">
                Código de verificação Apple
              </label>
              <Input
                id="icloud-login-code"
                name="one-time-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="font-mono text-base tracking-[.25em]"
              />
              <p className="text-xs leading-5 text-slate-400">
                Confira o código de seis dígitos exibido ou enviado pela Apple ao seu dispositivo confiável.
                A verificação expira após dez minutos.
              </p>
              <button type="button" className="text-xs text-sky-300 underline underline-offset-4" onClick={reset}>
                Recomeçar com a senha
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={pending || (phase === 'password' ? !password : code.length !== 6)}
            className="w-full sm:w-auto"
          >
            {phase === 'password' ? <KeyRound size={16} /> : <Check size={16} />}
            {pending ? 'Validando com a Apple…' : phase === 'password' ? 'Conectar ao iCloud' : 'Confirmar código e renovar sessão'}
          </Button>
        </form>
      )}
      <p className="text-[11px] leading-5 text-slate-500">
        A conta Apple configurada no servidor é utilizada automaticamente. A renovação não dispara downloads,
        migrações ou importações.
      </p>
    </Card>
  );
}
