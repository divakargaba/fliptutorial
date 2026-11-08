import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/legacy-modes/mode/go';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import type { Language } from '../v2/types';

function syntax(language: Language) {
  switch (language) {
    case 'python': return python();
    case 'javascript': return javascript();
    case 'typescript': return javascript({ typescript: true });
    case 'java': return java();
    case 'c': case 'cpp': return cpp();
    case 'sql': return sql();
    case 'rust': return rust();
    case 'go': return StreamLanguage.define(go);
    case 'csharp': return StreamLanguage.define(csharp);
    default: return [];
  }
}

// Colours come from CSS variables so the editor follows YouTube's light/dark theme.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--bp-syn-keyword)' },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName)], color: 'var(--bp-syn-function)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--bp-syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--bp-syn-number)' },
  { tag: [t.comment, t.lineComment], color: 'var(--bp-syn-comment)', fontStyle: 'italic' },
  { tag: [t.standard(t.variableName), t.self], color: 'var(--bp-syn-builtin)' },
  { tag: [t.variableName, t.definition(t.variableName), t.propertyName], color: 'var(--bp-text)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--bp-text-2)' },
]);

const theme = EditorView.theme({
  '&': { color: 'var(--bp-text)', backgroundColor: 'transparent', fontSize: '13px', height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--bp-mono)', lineHeight: '20px', minHeight: '176px', maxHeight: '300px', overflow: 'auto' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--bp-text)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--bp-text-3)', border: 'none', paddingLeft: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 6px', minWidth: '28px' },
  '.cm-foldGutter': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--bp-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--bp-text-2)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--bp-text)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bp-selection) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--bp-selection)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--bp-raised)', border: '1px solid var(--bp-line)', color: 'var(--bp-text)', borderRadius: '8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--bp-selection)', color: 'var(--bp-text)' },
});

export function PythonEditor({ initialCode, onChange, onRun, onSubmit, describedBy, language = 'python' }: {
  initialCode: string;
  onChange(code: string): void;
  onRun(): void;
  onSubmit(): void;
  describedBy?: string;
  language?: Language;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onChange, onRun, onSubmit });
  handlers.current = { onChange, onRun, onSubmit };
  useEffect(() => {
    const parent = host.current!;
    const root = parent.getRootNode();
    const editor = new EditorView({
      parent,
      root: root instanceof ShadowRoot ? root : document,
      doc: initialCode,
      extensions: [
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => { handlers.current.onRun(); return true; } },
          { key: 'Mod-Shift-Enter', run: () => { handlers.current.onSubmit(); return true; } },
        ])),
        basicSetup, syntax(language), syntaxHighlighting(highlight), theme,
        EditorView.contentAttributes.of({
          'aria-label': `${{ python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', cpp: 'C++', c: 'C', csharp: 'C#', go: 'Go', rust: 'Rust', sql: 'SQL', pseudocode: 'Pseudocode', unknown: 'Source' }[language]} code`, spellcheck: 'false', ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        }),
      ],
    });
    // Bubble-phase isolation keeps YouTube hotkeys (space, j, k, l, f) out while preserving Tab escape.
    const isolate = (event: Event) => event.stopPropagation();
    for (const type of ['keydown', 'keyup', 'keypress']) parent.addEventListener(type, isolate);
    return () => {
      for (const type of ['keydown', 'keyup', 'keypress']) parent.removeEventListener(type, isolate);
      editor.destroy();
    };
  }, []);
  return <div className="bp-editor" ref={host} />;
}
