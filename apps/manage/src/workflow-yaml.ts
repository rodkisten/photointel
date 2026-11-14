import { load } from 'js-yaml';

export type WorkflowInput = {
  description: string;
  type: 'string' | 'choice' | 'boolean' | 'environment' | 'number';
  required: boolean;
  default: string;
  options: string[];
};

export function parseWorkflowInputs(source: string): { dispatchable: boolean; inputs: Record<string, WorkflowInput> } {
  const document: unknown = load(source, { json: true });
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Workflow YAML inválido');
  const root = document as Record<string, unknown>;
  const events = root.on;
  const dispatch = events && typeof events === 'object' && !Array.isArray(events)
    ? (events as Record<string, unknown>).workflow_dispatch
    : Array.isArray(events) ? events.includes('workflow_dispatch') : events === 'workflow_dispatch';
  const hasDispatch = events && typeof events === 'object' && !Array.isArray(events)
    ? Object.prototype.hasOwnProperty.call(events, 'workflow_dispatch')
    : Boolean(dispatch);
  if (!hasDispatch || dispatch === false) return { dispatchable: false, inputs: {} };
  const definitions = dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch)
    ? (dispatch as Record<string, unknown>).inputs : undefined;
  if (definitions === undefined) return { dispatchable: true, inputs: {} };
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) throw new Error('Inputs inválidos');
  const inputs: Record<string, WorkflowInput> = {};
  for (const [key, raw] of Object.entries(definitions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Input inválido: ' + key);
    const field = raw as Record<string, unknown>;
    const type = ['choice', 'boolean', 'environment', 'number'].includes(String(field.type)) ? String(field.type) as WorkflowInput['type'] : 'string';
    const options = Array.isArray(field.options) ? field.options.map(String) : [];
    inputs[key] = {
      description: typeof field.description === 'string' ? field.description : '',
      type,
      required: field.required === true,
      default: field.default == null ? '' : String(field.default),
      options,
    };
  }
  return { dispatchable: true, inputs };
}
