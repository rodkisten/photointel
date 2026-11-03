import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Apple,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { Badge, Button, Card, Input } from './ui';
import { ApiError, api, send } from '../lib/client';

type Readiness = {
  ready: boolean;
  code: string;
  message: string;
};
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
type Phase = 'password' | 'verify' | 'expired' | 'connected';

function LoginSteps({ phase }: { phase: Phase }) {
  const current = phase === 'password' ? 1 : phase === 'connected' ? 3 : 2;
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Etapas da autenticação">
      {(['Senha', 'Verificação', 'Concluído'] as const).map((label, index) => {
        const step = index + 1;
        return (
          <li
            key={label}
            aria-current={current === step ? 'step' : undefined}
            className={`min-w-0 rounded-lg border px-2 py-2 text-center text-[11px] font-medium sm:text-xs ${
              current >= step
                ? 'border-carbon-500 bg-carbon-800 text-carbon-100'
                : 'border-carbon-800 bg-carbon-950 text-carbon-500'
            }`}
          >
            {step}. {label}
          </li>
        );
      })}
    </ol>
  );
}

export function ICloudLoginForm({ onConnected }: { onConnected?: () => void }) {
  const ready = useQuery<Readiness>({
    queryKey: ['icloud-auth-readiness'],
    queryFn: () => api<Readiness>('/icloud/auth/status'),
    retry: false,
    staleTime: 20_000,
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [phase, setPhase] = useState<Phase>('password');
  const [mode, setMode] = useState<'2fa' | '2sa'>('2fa');
  const [expiresAt, setExpiresAt] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [library, setLibrary] = useState('');

  useEffect(() => {
    if (phase !== 'verify' || !expiresAt) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsRemaining(seconds);
      if (seconds === 0) {
        setChallenge('');
        setCode('');
        setPhase('expired');
        setError('A verificação expirou. Faça login novamente para receber um novo código.');
        setErrorCode('ICLOUD_MFA_EXPIRED');
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, phase]);

  function restart() {
    if (pending) return;
    setPassword('');
    setShowPassword(false);
    setCode('');
    setChallenge('');
    setExpiresAt(0);
    setError('');
    setErrorCode('');
    setCorrelationId('');
    setPhase('password');
    void ready.refetch();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !ready.data?.ready) return;
    const sendingCode = phase === 'verify';
    if (sendingCode && (!challenge || !/^\d{6}$/.test(code))) {
      setError('Digite os seis dígitos do código de verificação Apple.');
      return;
    }
    if (!sendingCode && password.length === 0) {
      setError('Informe a senha da sua Conta Apple.');
      return;
    }

    // Password, Apple code and encrypted challenge are ephemeral only.
    // Never send them in URLs, analytics, logs, Sentry or browser storage.
    const body = sendingCode ? { challenge, code } : { password };
    setPassword('');
    setCode('');
    setError('');
    setErrorCode('');
    setCorrelationId('');
    setPending(true);
    try {
      const result = sendingCode
        ? await send<AuthResponse>('/icloud/auth/verify', body)
        : await send<AuthResponse>('/icloud/auth/start', body);

      if (result.state === 'verification_required') {
        if (!result.challenge || !['2fa', '2sa'].includes(result.mode)) {
          throw new Error('A Apple não retornou uma sessão de verificação válida. Tente novamente.');
        }
        setChallenge(result.challenge);
        setMode(result.mode);
        setExpiresAt(Date.now() + Math.max(60, Math.min(result.expires_in, 600)) * 1000);
        setPhase('verify');
      } else if (result.valid === true && result.session_published === true) {
        setChallenge('');
        setExpiresAt(0);
        setLibrary(result.library);
        setPhase('connected');
        onConnected?.();
      } else {
        throw new Error('A sessão ainda não foi confirmada pela API.');
      }
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : 'Não foi possível autenticar. Tente novamente.';
      const issue = failure instanceof ApiError ? failure : null;
      setError(message);
      setErrorCode(issue?.code ?? '');
      setCorrelationId(issue?.correlationId ?? '');
      if (sendingCode && (/sessão de verificação|recomece|comece novamente/i.test(message))) {
        setChallenge('');
        setPhase('expired');
      }
      if (
        issue?.code === 'ICLOUD_SESSION_KEY_UNAVAILABLE' ||
        issue?.code === 'ICLOUD_SESSION_BACKEND_NOT_READY' ||
        issue?.code === 'ICLOUD_ACCOUNT_NOT_CONFIGURED'
      ) {
        void ready.refetch();
      }
    } finally {
      setPending(false);
    }
  }

  const available = ready.data?.ready === true;
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = String(secondsRemaining % 60).padStart(2, '0');

  return (
    <Card className="w-full min-w-0 space-y-5 border-carbon-700 p-4 sm:p-5" aria-label="Autenticação iCloud pelo navegador">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Apple size={22} className="mt-0.5 shrink-0 text-carbon-200" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-carbon-100">Conectar à Conta Apple</h2>
            <p className="mt-1 text-sm leading-5 text-carbon-400">
              Senha e autenticação de dois fatores no próprio Manage.
            </p>
          </div>
        </div>
        <Badge tone={phase === 'connected' ? 'success' : 'neutral'}>
          {phase === 'connected' ? 'Conectado' : phase === 'verify' ? '2FA' : 'Seguro'}
        </Badge>
      </div>

      <LoginSteps phase={phase} />

      {ready.isPending && phase === 'password' && (
        <div className="flex items-center gap-2 rounded-lg bg-carbon-900 p-3 text-sm text-carbon-300" role="status">
          <LoaderCircle size={16} className="animate-spin" /> Verificando acesso seguro à API…
        </div>
      )}

      {(ready.error || (ready.data && !available)) && phase !== 'connected' && (
        <section
          className="space-y-3 rounded-lg border border-amber-900/70 bg-carbon-900 p-3"
          role="alert"
          aria-label="Preparação do iCloud"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-300" />
            <div className="min-w-0 space-y-1">
              <strong className="text-sm text-carbon-100">Preparação do iCloud necessária</strong>
              <p className="text-sm leading-5 text-carbon-300">
                {ready.data?.message ??
                  (ready.error instanceof Error
                    ? ready.error.message
                    : 'Não foi possível verificar o backend de autenticação.')}
              </p>
              <p className="text-xs leading-5 text-carbon-400">
                A chave de criptografia do servidor é diferente da sua senha Apple.
                Não é necessário criar uma senha de 32 caracteres.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void ready.refetch()} disabled={ready.isFetching}>
              <RotateCcw size={15} /> Verificar novamente
            </Button>
            <Button type="button" size="sm" variant="outline" asChild>
              <a href="/?tab=secrets">Abrir Secret Manager</a>
            </Button>
            <Button type="button" size="sm" variant="outline" asChild>
              <a href="/?tab=deploy">Ver deploys</a>
            </Button>
          </div>
        </section>
      )}

      {phase === 'connected' ? (
        <section className="space-y-3 rounded-lg border border-carbon-700 bg-carbon-900 p-4" role="status">
          <div className="flex items-center gap-2 text-sm font-medium text-emerald-300">
            <ShieldCheck size={20} /> Sessão Apple renovada e verificada
          </div>
          <p className="text-sm leading-6 text-carbon-300">
            A biblioteca <strong className="break-all text-carbon-100">{library}</strong> está acessível.
            A sessão criptografada foi publicada após confirmar o acesso às fotos.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={restart}>
            <RotateCcw size={15} /> Renovar novamente
          </Button>
        </section>
      ) : phase === 'expired' ? (
        <section className="space-y-3 rounded-lg border border-carbon-700 bg-carbon-900 p-4" role="alert">
          <strong className="flex items-center gap-2 text-sm text-carbon-100">
            <AlertTriangle size={18} /> Verificação não concluída
          </strong>
          <p className="text-sm leading-6 text-carbon-300">
            A sessão temporária terminou ou a Apple solicitou um novo login.
            Recomece com sua senha para gerar um código novo.
          </p>
          <Button type="button" className="w-full sm:w-auto" onClick={restart}>
            <RotateCcw size={15} /> Recomeçar autenticação
          </Button>
        </section>
      ) : (
        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          {phase === 'password' ? (
            <div className="space-y-2">
              <label htmlFor="icloud-login-password" className="text-sm font-medium text-carbon-200">
                Senha da Conta Apple
              </label>
              <div className="relative min-w-0">
                <Input
                  id="icloud-login-password"
                  name="icloud-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Digite sua senha Apple"
                  maxLength={512}
                  required
                  disabled={pending || !available}
                  className="w-full min-w-0 pr-12 text-base"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  onClick={() => setShowPassword((old) => !old)}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-carbon-400"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              <p className="text-xs leading-5 text-carbon-400">
                Qualquer tamanho entre 1 e 512 caracteres é aceito pelo formulário.
                A senha não fica armazenada no Manage.
              </p>
            </div>
          ) : (
            <section className="space-y-3 rounded-lg border border-carbon-700 bg-carbon-900 p-3" aria-label="Código de dois fatores">
              <div className="flex items-start gap-2">
                <ShieldCheck size={19} className="mt-0.5 shrink-0 text-carbon-200" />
                <div>
                  <h3 className="text-sm font-semibold text-carbon-100">
                    {mode === '2fa' ? 'Autenticação de dois fatores' : 'Verificação de duas etapas'}
                  </h3>
                  <p className="mt-1 text-sm leading-5 text-carbon-300">
                    Digite aqui o código de seis dígitos exibido no dispositivo Apple confiável.
                  </p>
                </div>
              </div>
              <label htmlFor="icloud-login-code" className="block text-sm font-medium text-carbon-200">
                Código de verificação
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
                disabled={pending}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                aria-describedby="icloud-code-expiration"
                className="w-full min-w-0 text-center font-mono text-[21px] tracking-[.38em]"
              />
              <p id="icloud-code-expiration" className="text-xs text-carbon-400">
                Tempo restante: <strong className="font-mono text-carbon-200">{minutes}:{seconds}</strong>.
                Use sempre o código mais recente.
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={restart} disabled={pending}>
                <ChevronLeft size={15} /> Voltar e solicitar um novo login
              </Button>
            </section>
          )}

          {error && (
            <div role="alert" className="space-y-1 rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
              <p className="break-words">{error}</p>
              {errorCode && <p className="font-mono text-xs text-red-300">{errorCode}</p>}
              {correlationId && (
                <a
                  href={`/?tab=logs&source=gcp&correlation=${encodeURIComponent(correlationId)}`}
                  className="text-xs text-carbon-200 underline underline-offset-4"
                >
                  Consultar ocorrência no Manage
                </a>
              )}
            </div>
          )}

          <Button
            type="submit"
            disabled={pending || !available || (phase === 'password' ? password.length === 0 : code.length !== 6)}
            className="w-full sm:w-auto"
          >
            {pending ? <LoaderCircle size={16} className="animate-spin" /> : phase === 'password' ? <KeyRound size={16} /> : <Check size={16} />}
            {pending
              ? phase === 'password'
                ? 'Entrando na Conta Apple…'
                : 'Confirmando código e biblioteca…'
              : phase === 'password'
                ? 'Continuar para a verificação'
                : 'Confirmar código e conectar'}
          </Button>
        </form>
      )}

      <p className="text-xs leading-5 text-carbon-500">
        O login usa a conta Apple já configurada no servidor. Nenhuma importação ou download é iniciado.
        Não compartilhe senhas nem códigos de verificação.
      </p>
    </Card>
  );
}
