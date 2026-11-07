import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { python } from '@codemirror/lang-python';

export function PythonEditor({ initialCode, onChange }: {
  initialCode: string;
  onChange(code: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    const parent = host.current!;
    const root = parent.getRootNode();
    const editor = new EditorView({
      parent,
      root: root instanceof ShadowRoot ? root : document,
      doc: initialCode,
      extensions: [basicSetup, python(),
        EditorView.contentAttributes.of({ 'aria-label': 'Python code', 'aria-describedby': 'bp-editor-help', spellcheck: 'false' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) changed.current(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': { color: '#F4F4F5', backgroundColor: '#0E0E10', fontSize: '13px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', minHeight: '240px', maxHeight: '280px', overflow: 'auto' },
          '.cm-content': { padding: '12px 0', caretColor: '#93C5FD' },
          // basicSetup's fallback syntax palette targets a light canvas.
          '.cm-line span': { color: '#C4B5FD' },
          '.cm-gutters': { backgroundColor: '#0E0E10', color: '#A1A1AA', border: 'none' },
          '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#1B1B20' },
          '&.cm-focused': { outline: '2px solid #93C5FD', outlineOffset: '-2px' },
          '.cm-cursor': { borderLeftColor: '#93C5FD' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#29405D' },
          '.cm-tooltip': { backgroundColor: '#121214', border: '1px solid #2B2B30', color: '#F4F4F5' },
        }, { dark: true }),
      ],
    });
    // Bubble-phase isolation preserves CodeMirror's handlers and native Tab escape.
    const isolate = (event: Event) => event.stopPropagation();
    for (const type of ['keydown', 'keyup', 'keypress']) parent.addEventListener(type, isolate);
    return () => {
      for (const type of ['keydown', 'keyup', 'keypress']) parent.removeEventListener(type, isolate);
      editor.destroy();
    };
  }, []);
  return <div className="bp-editor" ref={host} />;
}
