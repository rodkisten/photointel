import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../lib/client';
import { Card, Button, Textarea } from './ui';
const PLACEHOLDERS = ['workflow', 'run_number', 'run_id', 'job', 'step', 'error', 'diagnosis', 'url', 'repository', 'branch', 'sha', 'status'] as const;
const DEFAULT_TEMPLATE = '❌ {{workflow}} #{{run_number}}\\nJob: {{job}}\\nEtapa: {{step}}\\nErro: {{error}}\\nDiagnóstico: {{diagnosis}}\\n{{url}}';
function renderWorkflowMessage(template: string, values: Record<string, string>): string {
  return template.replace(/\\{\\{([a-z_]+)\\}\\}/g, (_, key: string) => values[key] || 'indisponível');
}

export function WorkflowMessageEditor() {
  const settings = useQuery({
    queryKey: ['github-message-template'],
    queryFn: () => api<{ template: string; placeholders: string[] }>('/workflows/message-template'),
  });
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  useEffect(() => { if (settings.data) setTemplate(settings.data.template); }, [settings.data]);
  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/workflows/message-template', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template }),
      });
      if (!response.ok) throw new Error('Não foi possível salvar o template');
    },
  });
  const sample = {
    workflow: 'TF Deploy', run_number: '42', run_id: '123456',
    job: 'Terraform Apply', step: 'Apply infrastructure',
    error: 'Permission denied', diagnosis: 'Verifique as permissões IAM.',
    url: 'https://github.com/rodkisten/photointel/actions/runs/123456',
    repository: 'rodkisten/photointel', branch: 'main', sha: 'abcdef12', status: 'failure',
  };
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-semibold text-carbon-100">Editor de notificações GitHub</h3>
        <p className="text-xs text-carbon-400">Use placeholders para personalizar a mensagem enviada ao Telegram.</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PLACEHOLDERS.map(key => (
          <button key={key} type="button" onClick={() => setTemplate(value => value + '{{' + key + '}}')}
            className="rounded-md border border-carbon-700 px-2 py-1 text-xs text-carbon-300 hover:bg-carbon-800">
            {'{{' + key + '}}'}
          </button>
        ))}
      </div>
      <Textarea value={template} onChange={event => setTemplate(event.target.value)} rows={7} />
      <div className="rounded-md border border-carbon-800 bg-carbon-950 p-3">
        <p className="mb-2 text-xs font-medium text-carbon-400">Prévia</p>
        <pre className="whitespace-pre-wrap break-words text-xs text-carbon-200">{renderWorkflowMessage(template, sample)}</pre>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={save.isPending || template.length > 3500 || !template.trim()} onClick={() => save.mutate()}>
          {save.isPending ? 'Salvando...' : 'Salvar template'}
        </Button>
        {save.isSuccess && <span className="text-xs text-emerald-300">Salvo no GitHub Actions Variables.</span>}
        {save.isError && <span className="text-xs text-red-300">Falha ao salvar.</span>}
      </div>
    </Card>
  );
}
