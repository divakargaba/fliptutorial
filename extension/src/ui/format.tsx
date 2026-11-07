import { Fragment, type ReactNode } from 'react';

/** 9803.3 -> "2:43:23" (YouTube's own timestamp style). */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function functionName(starterCode: string): string | null {
  return /def\s+([A-Za-z_]\w*)\s*\(/.exec(starterCode)?.[1] ?? null;
}

export function formatValue(value: unknown): string {
  if (value === undefined) return 'no output';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  return JSON.stringify(value, (_k, v) => (v === true ? 'True' : v === false ? 'False' : v === null ? 'None' : v))
    .replaceAll('"True"', 'True').replaceAll('"False"', 'False').replaceAll('"None"', 'None');
}

export function formatCall(name: string | null, args: unknown[]): string {
  return `${name ?? 'solution'}(${args.map(formatValue).join(', ')})`;
}

// Identifiers, calls, operators and `backticked` spans read as code in problem statements.
const CODE_TOKEN = /(`[^`]+`|\b[A-Za-z_]\w*\([^()]*\)|\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\b|\*\*|==|!=|<=|>=)/g;

/** Renders model/reviewer text as plain text, with code-like tokens in <code>. Never injects HTML. */
export function richText(text: string): ReactNode {
  return text.split(CODE_TOKEN).map((part, i) =>
    i % 2 === 1
      ? <code key={i} className="bp-inline-code">{part.replace(/^`|`$/g, '')}</code>
      : <Fragment key={i}>{part}</Fragment>);
}
