import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

/** Submitted-code snapshot: diagnoses never drift onto edited code. */
export function FeedbackEditor({ code, lines }: { code: string; lines: { line: number; note: string }[] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const doc = EditorState.create({ doc: code }).doc;
    const marked = new Map<number, string[]>();
    for (const { line, note } of lines) {
      if (!Number.isInteger(line) || line < 1 || line > doc.lines) continue;
      marked.set(line, [...(marked.get(line) ?? []), note]);
    }
    const decorations = [...marked].sort(([a], [b]) => a - b).map(([line, notes]) => Decoration.line({
      attributes: { class: 'bp-v2-diagnosed-line', title: notes.join(' '), 'data-diagnosis-line': String(line) },
    }).range(doc.line(line).from));
    const root = host.current!.getRootNode();
    const view = new EditorView({ parent: host.current!, root: root instanceof ShadowRoot ? root : document,
      state: EditorState.create({ doc: code, extensions: [basicSetup, EditorState.readOnly.of(true),
        EditorView.decorations.of(Decoration.set(decorations)), EditorView.contentAttributes.of({ 'aria-label': 'Submitted code with diagnosis', 'aria-readonly': 'true' }),
        EditorView.theme({ '&': { fontSize: '13px', backgroundColor: 'var(--bp-editor-bg)', color: 'var(--bp-text)' }, '.cm-scroller': { maxHeight: '240px', overflow: 'auto' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'var(--bp-raised)', color: 'var(--bp-text-2)' } })] }),
    });
    const isolate = (event: Event) => event.stopPropagation();
    const parent = host.current!;
    for (const type of ['keydown', 'keyup', 'keypress']) parent.addEventListener(type, isolate);
    return () => { for (const type of ['keydown', 'keyup', 'keypress']) parent.removeEventListener(type, isolate); view.destroy(); };
  }, [code, lines]);
  return <div className="bp-v2-code" ref={host} />;
}
