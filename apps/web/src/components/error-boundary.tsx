import { Component, type ReactNode } from 'react';
import { AlertTriangle, ClipboardCopy, ExternalLink, RefreshCw } from 'lucide-react';
import { diagnosticClipboardText, diagnosticFor, diagnosticLogsUrl, reportDiagnostic,
  type Diagnostic } from '../lib/diagnostics';

export function DiagnosticActions({ incident }: { incident: Diagnostic }) {
  const label = incident.source === 'gcp' ? 'Ver logs no GCP' : 'Ver logs no Cloudflare';
  return <div className="diagnostic-actions">
    <span className="diagnostic-id">Correlation ID: <code>{incident.id}</code></span>
    <button type="button" onClick={() => {
      void navigator.clipboard.writeText(diagnosticClipboardText(incident)).catch(() => {
        console.warn('[PhotoIntel] Área de transferência indisponível');
      });
    }}><ClipboardCopy size={14} />Copiar diagnóstico</button>
    <a href={diagnosticLogsUrl(incident)} target="_blank" rel="noopener noreferrer">
      <ExternalLink size={14} />{label}</a>
    {incident.source === 'cloudflare' &&
      <small>Abra o Worker photointel → Observability e pesquise pelo correlation_id.</small>}
  </div>;
}

interface Props { children: ReactNode }
interface State { error: Error | null; incident: Diagnostic | null }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, incident: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    document.getElementById('boot-splash')?.remove();
    this.setState({ incident: reportDiagnostic(error, 'render') });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const incident = this.state.incident ?? diagnosticFor(this.state.error, 'render');
    return <main className="crash-screen" role="alert" data-photointel-error>
      <div className="crash-card">
        <AlertTriangle size={30} aria-hidden="true" />
        <p className="eyebrow">Photo Intelligence Cloud</p>
        <h1>Não foi possível exibir esta página</h1>
        <p>A aplicação encontrou um erro inesperado. Os dados originais não foram alterados.</p>
        <details>
          <summary>Detalhes técnicos</summary>
          <pre>{this.state.error.toString()}</pre>
        </details>
        <DiagnosticActions incident={incident} />
        <button type="button" className="crash-retry" onClick={() => window.location.reload()}>
          <RefreshCw size={16} /> Recarregar o aplicativo
        </button>
      </div>
    </main>;
  }
}
