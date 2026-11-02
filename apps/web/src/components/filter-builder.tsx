import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../api/client';
import type { FilterNode, Page, Tag } from '../api/types';
import { Button } from './ui/button';

const fields: { value: FilterNode['op']; label: string }[] = [
  { value: 'tag', label: 'Palavra-chave' },
  { value: 'text', label: 'Texto exato' },
  { value: 'date', label: 'Data de captura' },
  { value: 'number', label: 'Tamanho (bytes)' },
  { value: 'media_type', label: 'Tipo de mídia' },
  { value: 'source', label: 'Biblioteca (ID)' },
  { value: 'duplicate', label: 'Duplicadas' },
  { value: 'quality', label: 'Nitidez mínima' },
  { value: 'screenshots', label: 'Capturas de tela' },
];
export const emptyGroup = (): FilterNode => ({
  op: 'and',
  children: [{ op: 'tag', value: '', confidence: 0 }],
});
export function cleanFilter(node: FilterNode): FilterNode | undefined {
  if (['and', 'or', 'not'].includes(node.op)) {
    const children = (node.children ?? []).map(cleanFilter).filter((child): child is FilterNode => !!child);
    return children.length
      ? { op: node.op, children: node.op === 'not' ? children.slice(0, 1) : children }
      : undefined;
  }
  if (['tag', 'text', 'source', 'album'].includes(node.op) && !String(node.value ?? '').trim())
    return undefined;
  if (node.op === 'date' && !node.minimum && !node.maximum) return undefined;
  return node;
}
export function FilterBuilder({
  node,
  onChange,
  depth = 0,
}: {
  node: FilterNode;
  onChange: (node: FilterNode) => void;
  depth?: number;
}) {
  const children = node.children ?? [];
  const changeChild = (index: number, value: FilterNode) =>
    onChange({ ...node, children: children.map((child, position) => (position === index ? value : child)) });
  return (
    <div className="filter-group">
      <div className="inline between">
        <label className="field">
          <span className="sr-only">Operador do grupo nível {depth + 1}</span>
          <select
            value={node.op}
            onChange={(event) =>
              onChange({
                op: event.target.value as FilterNode['op'],
                children: event.target.value === 'not' ? children.slice(0, 1) : children,
              })
            }
          >
            <option value="and">Todas as regras (AND)</option>
            <option value="or">Qualquer regra (OR)</option>
            <option value="not">Excluir regra (NOT)</option>
          </select>
        </label>
        <span className="field-help">Grupo {depth + 1}</span>
      </div>
      {children.map((child, index) => (
        <div key={index} style={{ marginBottom: 9 }}>
          {['and', 'or', 'not'].includes(child.op) ? (
            <div>
              <FilterBuilder node={child} depth={depth + 1} onChange={(value) => changeChild(index, value)} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({ ...node, children: children.filter((_, position) => position !== index) })
                }
              >
                <X size={12} />
                Remover grupo
              </Button>
            </div>
          ) : (
            <FilterLeaf
              node={child}
              onChange={(value) => changeChild(index, value)}
              onRemove={() =>
                onChange({ ...node, children: children.filter((_, position) => position !== index) })
              }
            />
          )}
        </div>
      ))}
      {(node.op !== 'not' || children.length === 0) && children.length < 20 && (
        <div className="filter-controls">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onChange({
                ...node,
                children: [...children, { op: 'tag', value: '', confidence: 0 }],
              })
            }
          >
            <Plus size={12} />
            Regra
          </Button>
          {depth < 6 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  ...node,
                  children: [...children, emptyGroup()],
                })
              }
            >
              <Plus size={12} />
              Grupo aninhado
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
function FilterLeaf({
  node,
  onChange,
  onRemove,
}: {
  node: FilterNode;
  onChange: (node: FilterNode) => void;
  onRemove: () => void;
}) {
  const [suggest, setSuggest] = useState(false);
  const suggestions = useApi<Page<Tag>>(
    `/v1/search/suggestions?q=${encodeURIComponent(String(node.value ?? '').slice(0, 100))}`,
  );
  function choose(op: FilterNode['op']) {
    const defaults: Partial<FilterNode> =
      op === 'date'
        ? { key: 'captured_at', minimum: '', maximum: '' }
        : op === 'number'
          ? { key: 'filesize', value: 20 * 1024 ** 2, comparison: 'lt' }
          : op === 'quality'
            ? { key: 'sharpness', value: 50, comparison: 'gte' }
            : op === 'media_type'
              ? { value: 'image' }
              : ['duplicate', 'screenshots'].includes(op)
                ? { value: true }
                : { value: '' };
    onChange({ op, ...defaults });
  }
  return (
    <div className="filter-row">
      <label className="field">
        <span className="sr-only">Tipo da regra</span>
        <select value={node.op} onChange={(event) => choose(event.target.value as FilterNode['op'])}>
          {fields.map((field) => (
            <option key={field.value} value={field.value}>
              {field.label}
            </option>
          ))}
        </select>
      </label>
      <div>
        {node.op === 'date' ? (
          <div className="inline" style={{ flexWrap: 'nowrap', gap: 5 }}>
            <input
              type="date"
              aria-label="Data inicial"
              className="input"
              value={String(node.minimum ?? '')}
              onChange={(event) => onChange({ ...node, minimum: event.target.value || undefined })}
            />
            <input
              type="date"
              aria-label="Data final"
              className="input"
              value={String(node.maximum ?? '')}
              onChange={(event) => onChange({ ...node, maximum: event.target.value || undefined })}
            />
          </div>
        ) : node.op === 'media_type' ? (
          <select
            className="input"
            value={String(node.value)}
            aria-label="Valor do tipo de mídia"
            onChange={(event) => onChange({ ...node, value: event.target.value })}
          >
            <option value="image">Fotografia</option>
            <option value="video">Vídeo</option>
            <option value="live_photo">Live Photo</option>
          </select>
        ) : ['screenshots', 'duplicate'].includes(node.op) ? (
          <select
            className="input"
            value={String(node.value)}
            aria-label="Incluir ou excluir"
            onChange={(event) => onChange({ ...node, value: event.target.value === 'true' })}
          >
            <option value="true">Incluir</option>
            <option value="false">Excluir</option>
          </select>
        ) : ['number', 'quality'].includes(node.op) ? (
          <div className="inline" style={{ flexWrap: 'nowrap', gap: 5 }}>
            <select
              className="input"
              style={{ width: 70 }}
              aria-label="Comparação numérica"
              value={node.comparison ?? 'gte'}
              onChange={(event) =>
                onChange({ ...node, comparison: event.target.value as FilterNode['comparison'] })
              }
            >
              <option value="gte">≥</option>
              <option value="lte">≤</option>
              <option value="eq">=</option>
              <option value="lt">&lt;</option>
              <option value="gt">&gt;</option>
              <option value="ne">≠</option>
            </select>
            <input
              className="input"
              type="number"
              min={0}
              aria-label="Valor numérico"
              value={Number(node.value ?? 0)}
              onChange={(event) => onChange({ ...node, value: Number(event.target.value) })}
            />
          </div>
        ) : (
          <div>
            <input
              className="input"
              aria-label={node.op === 'tag' ? 'Pesquisar palavra-chave' : 'Valor da regra'}
              maxLength={500}
              value={String(node.value ?? '')}
              onFocus={() => setSuggest(true)}
              onChange={(event) => onChange({ ...node, value: event.target.value })}
            />
            {node.op === 'tag' && suggest && !!suggestions.data?.items.length && (
              <div className="suggestions">
                {suggestions.data.items.slice(0, 6).map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      onChange({ ...node, value: tag.canonical_key });
                      setSuggest(false);
                    }}
                  >
                    {tag.display_name}
                    <small>{tag.canonical_key}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {node.op === 'tag' ? (
        <label className="field confidence-field">
          Confiança ≥
          <input
            type="number"
            className="input"
            min={0}
            max={100}
            step={1}
            value={Math.round((node.confidence ?? 0) * 100)}
            onChange={(event) =>
              onChange({
                ...node,
                confidence: Math.max(0, Math.min(1, Number(event.target.value) / 100)),
              })
            }
          />
        </label>
      ) : (
        <span />
      )}
      <Button
        className="remove-rule"
        variant="ghost"
        size="icon"
        aria-label="Remover regra"
        onClick={onRemove}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
