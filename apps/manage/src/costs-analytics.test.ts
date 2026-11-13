import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./costs.ts', import.meta.url), 'utf8');
const ui = readFileSync(new URL('./pages/Costs.tsx', import.meta.url), 'utf8');

describe('Manage costs analytics guardrails', () => {
  it('uses parameterized BigQuery aggregation and bounded pages', () => {
    expect(source).toContain('COUNT(*) OVER() AS group_count');
    expect(source).toContain('SUM(net) OVER() AS all_groups_net');
    expect(source).toContain('LIMIT @limit OFFSET @offset');
    expect(source).toContain("![10, 20, 50].includes(size)");
    expect(source).toContain("maximumBytesBilled: '100000000'");
  });
  it('keeps operational requests separate from billing and warnings', () => {
    expect(source).toContain('run.googleapis.com/request_count');
    expect(source).toContain('Não representam custo faturado');
    expect(source).toContain('GCP_COST_ALERT_USD');
    expect(ui).toContain('não bloqueia serviços');
  });
  it('exposes accessible mobile pagination and drill-down', () => {
    expect(ui).toContain('Agrupamento BigQuery');
    expect(ui).toContain('Itens por página BigQuery');
    expect(ui).toContain('Operação recente');
  });
});
