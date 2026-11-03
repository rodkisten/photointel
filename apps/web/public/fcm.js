// Isolated Firebase Messaging runtime: failures must not block the React entrypoint.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  getAnalytics,
  isSupported as isAnalyticsSupported,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js';
import {
  getMessaging,
  isSupported as isMessagingSupported,
  onMessage,
  onRegistered,
  onUnregistered,
  register,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-messaging.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAnhQBb9OHKyg93cCyNxlPY4Ny5HW25vHY',
  authDomain: 'photointel-firebase.firebaseapp.com',
  projectId: 'photointel-firebase',
  storageBucket: 'photointel-firebase.firebasestorage.app',
  messagingSenderId: '723658488603',
  appId: '1:723658488603:web:64c64e34743b9aabe431be',
  measurementId: 'G-RE93MWG6FN',
};

// Firebase Console > Configuracoes do projeto > Cloud Messaging
// > Configuracao da Web > Certificados Web Push > Chave publica.
const VAPID_PUBLIC_KEY =
  'BPMDhEs2FPaek4BwM2UVJBrMrRnDDXxLRn8SDeji1hZNGC8hft0IEplz5Y7jKnfRGBb14iKWtbNyGOw__nXHCHQ';
const WORKER_URL = '/sw.js';

const app = initializeApp(firebaseConfig);
let registrationPromise = null;
let currentInstallation = null;

function emitState(state, message = '') {
  window.dispatchEvent(new CustomEvent('photointel:fcm-state', {
    detail: { state, message },
  }));
}

async function syncInstallation(installationId) {
  if (!navigator.onLine) {
    emitState('offline', 'O registro será sincronizado quando houver conexão.');
    return;
  }
  emitState('registering');
  const response = await fetch('/v1/push/registrations', {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: installationId }),
  });
  if (!response.ok) {
    throw new Error('A API não confirmou o registro do dispositivo (HTTP ' + response.status + ').');
  }
  emitState('registered', 'Este dispositivo está inscrito nas notificações de jobs.');
}

window.addEventListener('online', () => {
  if (currentInstallation) {
    void syncInstallation(currentInstallation).catch((error) => {
      console.warn('[PhotoIntel Push] Falha ao sincronizar registro:', error);
      emitState('error', error.message);
    });
  }
});

// O Analytics e opcional e nao deve impedir o funcionamento do Push.
isAnalyticsSupported()
  .then((supported) => {
    if (supported) {
      getAnalytics(app);
    }
  })
  .catch((error) => console.warn('[PhotoIntel Analytics]', error));

async function registerForPush(messaging) {
  if (VAPID_PUBLIC_KEY === 'COLE_AQUI_SUA_CHAVE_PUBLICA_VAPID') {
    throw new Error('Configure a chave publica VAPID antes de ativar o Push.');
  }

  if (registrationPromise) {
    return registrationPromise;
  }

  registrationPromise = (async () => {
    // Reutiliza o mesmo worker ja registrado por src/main.tsx.
    // Nao registra outro service worker no escopo raiz.
    const workerRegistration = await navigator.serviceWorker.register(WORKER_URL, {
      scope: '/',
      updateViaCache: 'none',
    });

    await register(messaging, {
      vapidKey: VAPID_PUBLIC_KEY,
      serviceWorkerRegistration: workerRegistration,
    });

    console.info('[PhotoIntel Push] Registro FCM iniciado.');
  })();

  try {
    await registrationPromise;
  } catch (error) {
    registrationPromise = null;
    throw error;
  }
}

const messagingReady = (async () => {
  if (
    !window.isSecureContext ||
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !(await isMessagingSupported())
  ) {
    console.warn('[PhotoIntel Push] Navegador ou contexto sem suporte a Web Push.');
    emitState('unsupported', 'No iPhone, instale o PhotoIntel na Tela de Início para ativar o push.');
    return null;
  }

  const messaging = getMessaging(app);

  onMessage(messaging, (payload) => {
    console.info('[PhotoIntel Push] Mensagem em primeiro plano:', payload);

    window.dispatchEvent(
      new CustomEvent('photointel:fcm-message', {
        detail: payload,
      }),
    );
    // No React, escute este evento e mostre seu toast/banner.
  });

  onRegistered(messaging, (installationId) => {
    if (!installationId) return;
    // O FID é um identificador de entrega, não uma credencial de servidor.
    // Não exponha seu valor em logs ou mensagens da interface.
    currentInstallation = installationId;
    void syncInstallation(installationId).catch((error) => {
      console.warn('[PhotoIntel Push] Falha no registro com a API:', error);
      emitState('error', error.message);
    });
  });

  onUnregistered(messaging, (installationId) => {
    if (!installationId) return;
    if (currentInstallation === installationId) currentInstallation = null;
    emitState('unregistered');
    void fetch('/v1/push/registrations', {
      method: 'DELETE',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: installationId }),
    }).catch(() => undefined);
  });

  // Se o usuario ja concedeu permissao, revalida o registro ao abrir o app.
  if (Notification.permission === 'granted') {
    void registerForPush(messaging).catch((error) => {
      console.error('[PhotoIntel Push] Falha na renovacao do registro:', error);
      emitState('error', error.message);
    });
  }

  return messaging;
})().catch((error) => {
  console.error('[PhotoIntel Push] Falha ao inicializar FCM:', error);
  emitState('error', 'Não foi possível iniciar o Firebase Messaging.');
  return null;
});

async function enableNotifications() {
  if (!('Notification' in window)) {
    throw new Error('Notificacoes nao sao suportadas neste navegador.');
  }

  // Deve ser chamado imediatamente no gesto do usuario (clique/toque).
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;

  if (permission !== 'granted') {
    throw new Error(`Permissao de notificacoes: ${permission}`);
  }

  const messaging = await messagingReady;
  if (!messaging) {
    throw new Error('Firebase Messaging indisponivel neste ambiente.');
  }

  await registerForPush(messaging);
  // onRegistered() confirms the Firebase ID and its association with the API.
  if (currentInstallation) {
    await syncInstallation(currentInstallation);
  }
}

// Dispare este evento diretamente no onClick de um botao React:
// document.dispatchEvent(new Event("photointel:enable-notifications"));
document.addEventListener('photointel:enable-notifications', () => {
  void enableNotifications().catch((error) => {
    console.error('[PhotoIntel Push] Nao foi possivel ativar:', error);
    emitState('error', error.message);
    window.dispatchEvent(
      new CustomEvent('photointel:fcm-error', {
        detail: { message: String(error), error },
      }),
    );
  });
});
