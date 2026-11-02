import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanFilter, emptyGroup, FilterBuilder } from '../components/filter-builder';
import type { FilterNode } from '../api/types';

function Editor() {
  const [node, change] = useState<FilterNode>(emptyGroup());
  return (
    <>
      <FilterBuilder node={node} onChange={change} />
      <output data-testid="filter-ast">{JSON.stringify(cleanFilter(node) ?? null)}</output>
    </>
  );
}

describe('structured search rules', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [{ id: 'tag-black-shirt', canonical_key: 'black_shirt', display_name: 'Camiseta preta' }],
          next_cursor: null,
        }),
      ),
    ),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('removes blank filters while retaining nested negation and explicit false', () => {
    expect(
      cleanFilter({
        op: 'and',
        children: [
          { op: 'tag', value: ' ' },
          { op: 'date' },
          { op: 'not', children: [{ op: 'screenshots', value: true }] },
          { op: 'duplicate', value: false },
          { op: 'number', key: 'filesize', value: 0, comparison: 'gte' },
        ],
      }),
    ).toEqual({
      op: 'and',
      children: [
        { op: 'not', children: [{ op: 'screenshots', value: true }] },
        { op: 'duplicate', value: false },
        { op: 'number', key: 'filesize', value: 0, comparison: 'gte' },
      ],
    });
    expect(cleanFilter(emptyGroup())).toBeUndefined();
  });

  it('constructs a tag and confidence rule from an actual typeahead selection', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Editor />
      </QueryClientProvider>,
    );
    await user.click(screen.getByLabelText('Pesquisar palavra-chave'));
    await user.click(await screen.findByRole('button', { name: /Camiseta preta/ }));
    await user.clear(screen.getByRole('spinbutton', { name: 'Confiança ≥' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Confiança ≥' }), '85');
    const result = JSON.parse(screen.getByTestId('filter-ast').textContent ?? 'null');
    expect(result).toEqual({ op: 'and', children: [{ op: 'tag', value: 'black_shirt', confidence: 0.85 }] });
    await user.click(screen.getByRole('button', { name: 'Remover regra' }));
    expect(screen.getByTestId('filter-ast')).toHaveTextContent('null');
  });

  it('changes nested groups and limits NOT to a single child', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Editor />
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Grupo aninhado' }));
    const nested = screen.getByLabelText('Operador do grupo nível 2');
    await user.selectOptions(nested, 'or');
    expect(nested).toHaveValue('or');
    await user.selectOptions(screen.getByLabelText('Operador do grupo nível 1'), 'not');
    expect(screen.queryByLabelText('Operador do grupo nível 2')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regra' })).toBeNull();
  });
});
