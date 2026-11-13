// --- TYPES & INTERFACES ---

export type GenericObject = Record<string, unknown>;

// --- CONFIGURATION & CONSTANTS ---

export const FORMAT_CONFIG = {
  LOCALE: 'pt-BR',
  FALLBACK_EMPTY: '—',
  FALLBACK_UNREGISTERED: 'Ainda não registrado',
  BYTE_MULTIPLIER: 1024,
  BYTE_UNITS: ['B', 'KB', 'MB', 'GB', 'TB'],
} as const; // 'as const' makes properties readonly and infers exact literal types

// --- FORMATTERS CACHE ---
// Caching Intl objects prevents significant performance overhead on repeated calls

const CACHED_FORMATTERS = {
  number: new Intl.NumberFormat(FORMAT_CONFIG.LOCALE, { 
    maximumFractionDigits: 2 
  }),
  dateOnly: new Intl.DateTimeFormat(FORMAT_CONFIG.LOCALE, { 
    dateStyle: 'long' 
  }),
  dateTime: new Intl.DateTimeFormat(FORMAT_CONFIG.LOCALE, { 
    dateStyle: 'medium', 
    timeStyle: 'short' 
  }),
} as const;

// --- DATA FORMATTING UTILITIES ---

export const number = (value: unknown): string => {
  return typeof value === 'number'
    ? CACHED_FORMATTERS.number.format(value)
    : FORMAT_CONFIG.FALLBACK_EMPTY;
};

export const date = (value: unknown, includeTime: boolean = false): string => {
  if (typeof value !== 'string' || !value.trim()) {
    return FORMAT_CONFIG.FALLBACK_UNREGISTERED;
  }

  const parsed = new Date(value);
  
  // Return the raw string if parsing fails, preventing silent data masking
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }

  return includeTime 
    ? CACHED_FORMATTERS.dateTime.format(parsed) 
    : CACHED_FORMATTERS.dateOnly.format(parsed);
};

export function bytes(value: unknown): string {
  if (typeof value !== 'number') return FORMAT_CONFIG.FALLBACK_EMPTY;
  
  const { BYTE_MULTIPLIER, BYTE_UNITS } = FORMAT_CONFIG;
  
  if (value < BYTE_MULTIPLIER) {
    return `${value} ${BYTE_UNITS[0]}`;
  }

  // Calculate the appropriate unit index securely
  const maxUnitIndex = BYTE_UNITS.length - 1;
  const unitIndex = Math.min(
    Math.floor(Math.log(value) / Math.log(BYTE_MULTIPLIER)),
    maxUnitIndex
  );

  const calculatedValue = value / (BYTE_MULTIPLIER ** unitIndex);
  
  return `${number(calculatedValue)} ${BYTE_UNITS[unitIndex]}`;
}

export const text = (value: unknown): string => {
  if (value === null || value === undefined) {
    return FORMAT_CONFIG.FALLBACK_EMPTY;
  }
  return typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);
};

// --- DATA EXTRACTION UTILITIES (STRICT TYPED) ---

// Custom Type Guard to narrow 'unknown' down to a safe GenericObject safely
export const isPlainObject = (value: unknown): value is GenericObject => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

export const obj = (value: unknown): GenericObject => {
  return isPlainObject(value) ? value : {};
};

export const items = (value: unknown): GenericObject[] => {
  return Array.isArray(value) ? value.map(obj) : [];
};

// --- STATUS DICTIONARY & TYPE INFERENCE ---

export const STATUS_MAPPING = {
  queued: 'Na fila',
  preparing: 'Preparando',
  running: 'Em execução',
  retrying: 'Nova tentativa',
  paused: 'Pausado',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
  operational: 'Operacional',
  unavailable: 'Indisponível',
  not_configured: 'Não configurado',
  not_implemented: 'Fora do v1',
  experimental: 'Experimental',
  test_only: 'Somente teste',
  pending: 'Pendente',
  claimed: 'Reservado',
  mapping_required: 'Vincular fotografia',
  awaiting_approval: 'Aguardando aprovação',
  processing: 'Processando',
  applied_on_device: 'Aplicado no dispositivo',
  awaiting_cloud_confirmation: 'Aguardando iCloud',
  conflict: 'Conflito',
  read_only: 'Somente leitura',
  write_verified: 'Escrita verificada',
  unverified: 'Não verificado',
  verified: 'Verificado',
  ambiguous: 'Ambíguo',
  unmapped: 'Sem vínculo',
  valid: 'Válida',
  unknown: 'Não verificada',
  discovered: 'Descoberto',
  downloading: 'Baixando',
  downloaded: 'Download concluído',
  quarantined: 'Em quarentena',
  blocked: 'Bloqueado',
  not_verified: 'Não verificado',
  passed: 'Passou',
  identified: 'Identificada',
  unidentified: 'Não identificada',
  configured: 'Configurado, não verificado',
  healthy: 'Disponível',
  degraded: 'Requer atenção',
} as const;

// Automatically generates a Union Type ('queued' | 'preparing' | 'running' | ...)
export type StatusKey = keyof typeof STATUS_MAPPING;

// Custom Type Guard to safely check if an arbitrary string is a valid StatusKey
export const isStatusKey = (key: string): key is StatusKey => {
  return key in STATUS_MAPPING;
};

export const statusLabel = (value: unknown): string => {
  // Enforces strictly typed dictionary access rather than casting 'String(value)'
  if (typeof value === 'string' && isStatusKey(value)) {
    return STATUS_MAPPING[value];
  }
  return text(value);
};
