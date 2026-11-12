import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, PLACEHOLDERS, renderWorkflowMessage } from '../src/workflow-message';

describe('workflow notification templates', () => {
  it('exposes the documented placeholders', () => {
    expect(PLACEHOLDERS).toContain('error');
    expect(PLACEHOLDERS).toContain('diagnosis');
    expect(PLACEHOLDERS).toContain('url');
  });
  it('renders supplied values and handles missing values', () => {
    expect(renderWorkflowMessage('{{workflow}}: {{error}}', {
      workflow: 'Deploy', error: 'Permission denied',
    })).toBe('Deploy: Permission denied');
    expect(renderWorkflowMessage('{{step}}', {})).toBe('indisponível');
  });
  it('provides a default template', () => {
    expect(DEFAULT_TEMPLATE).toContain('{{workflow}}');
    expect(DEFAULT_TEMPLATE).toContain('{{error}}');
  });
});
