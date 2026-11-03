import { Plus, Trash2 } from 'lucide-react';
import { Input, Button } from './ui';

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][\w]*)(\s*=\s*)(.*?)(\r?)$/;

export type DotenvField = {
  index: number;
  key: string;
  value: string;
  prefix: string;
  separator: string;
  suffix: string;
  comment: string;
  lineEnding: string;
};

function findComment(raw: string): number {
  let quote = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '\\' && quote === '"' && index + 1 < raw.length) {
      index++;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? '' : char;
      continue;
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]))) return index;
  }
  return -1;
}

export function parseDotenvFields(document: string): DotenvField[] {
  return document.split('\n').flatMap((line, index) => {
    const match = ASSIGNMENT.exec(line);
    if (!match) return [];
    const raw = match[4];
    const commentAt = findComment(raw);
    const withSpacing = commentAt >= 0 ? raw.slice(0, commentAt) : raw;
    const value = withSpacing.trimEnd();
    return [
      {
        index,
        key: match[2],
        value,
        prefix: match[1],
        separator: match[3],
        suffix: withSpacing.slice(value.length),
        comment: commentAt >= 0 ? raw.slice(commentAt) : '',
        lineEnding: match[5],
      },
    ];
  });
}

/** Replace exactly one assignment line; all other lines remain byte-for-byte intact. */
export function updateDotenvField(
  document: string,
  index: number,
  patch: { key?: string; value?: string },
): string {
  const lines = document.split('\n');
  const field = parseDotenvFields(document).find((item) => item.index === index);
  if (!field) return document;
  const key = patch.key ?? field.key;
  if (!/^[A-Za-z_][\w]*$/.test(key)) return document;
  const value = (patch.value ?? field.value).replace(/[\r\n]/g, '');
  lines[index] =
    field.prefix + key + field.separator + value + field.suffix + field.comment + field.lineEnding;
  return lines.join('\n');
}

export function appendDotenvField(document: string, key = 'NEW_KEY', value = ''): string {
  if (!/^[A-Za-z_][\w]*$/.test(key)) return document;
  const prefix = document && !document.endsWith('\n') ? '\n' : '';
  return document + prefix + key + '=' + value + '\n';
}

export function removeDotenvField(document: string, index: number): string {
  const lines = document.split('\n');
  if (!parseDotenvFields(document).some((entry) => entry.index === index)) return document;
  lines.splice(index, 1);
  return lines.join('\n');
}

export function DotenvFields({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const fields = parseDotenvFields(value);
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-carbon-400">
        Edição estruturada: comentários, ordem, prefixo export, espaçamento e linhas em branco são
        preservados. Para colar um .env completo, use a aba Código.
      </p>
      <div className="max-h-[min(58vh,520px)] space-y-2 overflow-y-auto pr-1">
        {fields.map((field) => (
          <div
            key={field.index}
            className="grid min-w-0 grid-cols-[1fr_auto] gap-2 rounded-lg border border-carbon-800 p-2 sm:grid-cols-[minmax(0,36%)_1fr_auto]"
          >
            <Input
              aria-label={'Chave da linha ' + (field.index + 1)}
              value={field.key}
              onChange={(event) =>
                onChange(updateDotenvField(value, field.index, { key: event.target.value }))
              }
              className="font-mono text-sm"
            />
            <Input
              aria-label={'Valor de ' + field.key}
              value={field.value}
              onChange={(event) =>
                onChange(updateDotenvField(value, field.index, { value: event.target.value }))
              }
              className="col-start-1 min-w-0 font-mono text-sm sm:col-start-auto"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={'Excluir variável ' + field.key}
              onClick={() => onChange(removeDotenvField(value, field.index))}
            >
              <Trash2 size={15} />
            </Button>
            {field.comment && (
              <p className="col-span-full break-words font-mono text-xs text-carbon-500">{field.comment}</p>
            )}
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => onChange(appendDotenvField(value, 'NEW_KEY_' + (fields.length + 1)))}
      >
        <Plus size={15} /> Adicionar variável
      </Button>
    </div>
  );
}
