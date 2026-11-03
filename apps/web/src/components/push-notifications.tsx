import { BellRing, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { json, request, useApi } from '../api/client';
import { Button } from './ui/button';
import { useUi } from '../lib/store';

type PushState = 'idle' | 'unsupported' | 'registering' | 'registered' | 'unregistered' | 'offline' | 'error';
type PushStatus = { enabled: boolean; registered_devices: number };
type PushEvent = CustomEvent<{ state: PushState; message?: string }>;

export function PushNotifications() {
  const [state, setState] = useState<PushState>('idle');
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const status = useApi<PushStatus>('/v1/push/status', 60_000);
  const supported =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;
  const permission = supported ? Notification.permission : 'unsupported';

  useEffect(() => {
    const listen = (event: Event) => {
      const { state: next, message: detail } = (event as PushEvent).detail;
      setState(next);
      setMessage(detail ?? '');
      if (next === 'registered') void status.refetch();
    };
    window.addEventListener('photointel:fcm-state', listen);
    return () => window.removeEventListener('photointel:fcm-state', listen);
  }, [status.refetch]);

  async function testPush() {
    setTesting(true);
    try {
      const result = await request<{ sent: number }>('/v1/push/test', json('POST'));
      useUi.getState().notify(`Teste enviado para ${result.sent} dispositivo(s).`, 'success');
    } catch (error) {
      useUi.getState().notify(
        error instanceof Error ? error.message : 'Não foi possível enviar o teste FCM.',
        'error',
      );
    } finally {
      setTesting(false);
    }
  }

  const description =
    message ||
    (!supported
      ? 'No iPhone, adicione o PhotoIntel à Tela de Início e abra o aplicativo instalado.'
      : permission === 'denied'
        ? 'Notificações bloqueadas. Autorize o PhotoIntel nos ajustes do dispositivo.'
        : state === 'registered' || (permission === 'granted' && (status.data?.registered_devices ?? 0) > 0)
          ? 'Dispositivo inscrito. Você receberá atualizações dos jobs mesmo fora da tela.'
          : permission === 'granted'
            ? 'Permissão concedida. Sincronizando o registro com a API.'
            : 'Ative para acompanhar falhas e conclusão de jobs mesmo com o PWA fechado.');

  return (
    <section className="panel" aria-label="Notificações Firebase" style={{ marginTop: 20 }}>
      <div className="panel-title">
        <h2>Notificações de processamento</h2>
        <BellRing size={16} aria-hidden="true" />
      </div>
      <p className="muted">{description}</p>
      {!status.isPending && status.data && !status.data.enabled && (
        <p className="muted">
          O recebimento ainda depende da ativação do emissor FCM na API.
        </p>
      )}
      <div className="header-actions" style={{ marginTop: 14 }}>
        <Button
          type="button"
          onClick={() => {
            setState('registering');
            setMessage('Solicitando permissão e vinculando o dispositivo…');
            // Dispatch synchronously from the user gesture (iOS Web Push).
            document.dispatchEvent(new Event('photointel:enable-notifications'));
          }}
          disabled={!supported || permission === 'denied' || state === 'registering'}
        >
          <BellRing size={15} />
          {state === 'registered' ? 'Renovar inscrição' : 'Ativar notificações'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!supported || permission !== 'granted' || !status.data?.enabled || testing}
          onClick={() => void testPush()}
        >
          <Send size={15} />
          {testing ? 'Enviando…' : 'Enviar teste'}
        </Button>
      </div>
    </section>
  );
}
