import { describe, expect, it } from 'vitest';
import { appendDotenvField, parseDotenvFields, removeDotenvField, updateDotenvField } from './dotenv-fields';

describe('lossless dotenv key-value editor', () => {
  const source = '# production comments\n\nexport FIRST = "hello # world"  # inline\nSECOND=2\n# final comment\n';
  it('parses quoted hash signs and keeps original comments intact', () => {
    const fields = parseDotenvFields(source);
    expect(fields).toHaveLength(2);
    expect(fields[0].key).toBe('FIRST');
    expect(fields[0].value).toBe('"hello # world"');
    expect(fields[0].comment).toBe('# inline');
  });
  it('edits a single key or value without rewriting adjacent lines', () => {
    const edited = updateDotenvField(source, 2, { value: '"new #value"' });
    expect(edited).toContain('export FIRST = "new #value"  # inline');
    expect(edited).toContain('# production comments\n\n');
    expect(edited).toContain('SECOND=2\n# final comment\n');
    expect(updateDotenvField(edited, 3, { key: 'THIRD' })).toContain('THIRD=2');
  });
  it('adds and deletes entries without touching comments', () => {
    const added = appendDotenvField(source, 'THIRD', '3');
    expect(added).toContain('# final comment\nTHIRD=3\n');
    expect(removeDotenvField(added, 3)).not.toContain('SECOND=2');
    expect(removeDotenvField(added, 3)).toContain('# final comment');
    expect(updateDotenvField(source, 2, { key: 'INVALID KEY' })).toBe(source);
  });
});
