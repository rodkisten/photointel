import { useEffect, useRef } from 'react';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { linter } from '@codemirror/lint';
import { tags } from '@lezer/highlight';

export type EnvironmentFormat = 'json' | 'dotenv';
export const detectEnvironmentFormat = (value: string): EnvironmentFormat =>
  value.trimStart().startsWith('{') ? 'json' : 'dotenv';

/** Dotenv is intentionally a stream language: the exact document, comments and blank lines survive editing. */
export const dotenvLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.sol() && stream.match(/^\s*#.*$/)) return 'comment';
    if (stream.sol() && stream.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*(?=\s*=)/))
      return 'variableName';
    if (stream.match(/^\s*=\s*/)) return 'operator';
    if (stream.match(/^json:/)) return 'keyword';
    if (stream.match(/^["'](?:[^"'\\]|\\.)*["']/)) return 'string';
    if (stream.match(/^\s*#.*$/)) return 'comment';
    if (stream.match(/^[^\s#]+/)) return 'string';
    stream.next();
    return null;
  },
});

const syntax = HighlightStyle.define([
  { tag: tags.propertyName, color: '#92b5fc' },
  { tag: tags.variableName, color: '#9bc7fd', fontWeight: '600' },
  { tag: tags.string, color: '#b8d9a5' },
  { tag: tags.number, color: '#c9a6fa' },
  { tag: tags.bool, color: '#b9a6f7' },
  { tag: tags.null, color: '#9ba0a9' },
  { tag: tags.keyword, color: '#d5adf9' },
  { tag: tags.comment, color: '#7b818d', fontStyle: 'italic' },
  { tag: tags.operator, color: '#dde1e7' },
  { tag: tags.brace, color: '#d4d7dc' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: '#101113', color: '#e5e7eb', height: 'min(64vh, 520px)', fontSize: '13px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    overflow: 'auto',
  },
  '.cm-content': { minHeight: '320px', caretColor: '#ffffff', padding: '6px 2px' },
  '.cm-gutters': { backgroundColor: '#101113', color: '#737781', borderRight: '1px solid #292b30' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#25272d80' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#3b475a80' },
  '.cm-cursor': { borderLeftColor: '#fff' },
  '.cm-searchMatch': { backgroundColor: '#715c204d', outline: '1px solid #a4883a' },
  '.cm-searchMatch-selected': { backgroundColor: '#95762c' },
  '.cm-tooltip': { backgroundColor: '#202125', color: '#e7e7e7', border: '1px solid #44464a' },
  '.cm-panels': { backgroundColor: '#1e2024', color: '#e7e7e7' },
  '.cm-panel input': { fontSize: '16px', backgroundColor: '#111', color: '#fff' },
});

export function CodeMirrorEnvEditor({
  value,
  onChange,
  format,
  ariaLabel = 'Editar GCP_CONFIG_ENV',
}: {
  value: string;
  onChange: (value: string) => void;
  format: EnvironmentFormat;
  ariaLabel?: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbackRef = useRef(onChange);
  const languageRef = useRef(new Compartment());
  const lintRef = useRef(new Compartment());
  const activeFormat = useRef(format);
  callbackRef.current = onChange;

  useEffect(() => {
    if (!mount.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        drawSelection(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
        }),
        theme,
        syntaxHighlighting(syntax),
        languageRef.current.of(format === 'json' ? json() : dotenvLanguage),
        lintRef.current.of(format === 'json' ? linter(jsonParseLinter()) : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbackRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: mount.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ariaLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (activeFormat.current !== format) {
      activeFormat.current = format;
      view.dispatch({
        effects: [
          languageRef.current.reconfigure(format === 'json' ? json() : dotenvLanguage),
          lintRef.current.reconfigure(format === 'json' ? linter(jsonParseLinter()) : []),
        ],
      });
    }
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }, [value, format]);

  return (
    <div
      ref={mount}
      data-testid="codemirror-env-editor"
      className="min-w-0 overflow-hidden rounded-lg border border-[#35383e] focus-within:border-[#656b73]"
    />
  );
}
