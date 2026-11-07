import { SupabaseStatus } from "@/components/supabase-status";
import { ReadinessCheck } from "@/components/readiness-check";

const steps = [
  { number: "01", title: "Bring your team.", text: "Fill the ownership table. Test a board ping. Give each person a clear lane.", file: "AGENTS.md" },
  { number: "02", title: "Connect your tools.", text: "Fill the local environment file. Use Supabase for data and Next.js routes for AI.", file: "docs/CREDENTIALS.md" },
  { number: "03", title: "Drop the prompt.", text: "Give your lead agent the brief. Agree contracts, post the first tasks, and build the demo.", file: "prompts/kickoff.md" },
];

export default function Home() {
  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-8 sm:px-10">
      <header className="flex items-center justify-between border-b border-[var(--line)] pb-7 text-xs font-semibold tracking-widest">
        <span className="flex items-center gap-3"><span className="grid size-8 place-items-center rounded-lg bg-[var(--ink)] text-[var(--paper)]">↗</span> LAUNCHPAD</span>
        <span className="rounded-full border border-[var(--line)] px-3 py-2 text-[10px]">PREP PHASE</span>
      </header>
      <section className="grid gap-12 py-16 lg:grid-cols-[1.25fr_1fr] lg:items-center lg:py-24">
        <div>
          <p className="mb-6 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.2em] text-[var(--muted)]"><span className="size-2 rounded-full bg-[var(--green)]" /> Less setup. More building.</p>
          <h1 className="max-w-2xl text-6xl font-semibold leading-[1.02] tracking-[-.065em] sm:text-8xl">Ready for<br />the <span className="text-[var(--green)]">prompt.</span></h1>
          <p className="mt-8 max-w-md text-base leading-7 text-[var(--muted)]">Your stack is running. Your agents have a playbook. Bring a good problem, and turn it into one great demo.</p>
          <div className="mt-8 flex flex-wrap gap-2 text-[11px] font-medium">
            {["React + TypeScript", "Tailwind", "Supabase backend", "One great demo"].map(label => <span key={label} className="rounded-full border border-[var(--line)] px-3 py-2">{label}</span>)}
          </div>
        </div>
        <aside className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-7 sm:p-9">
          <div className="mb-9 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[.17em]"><span className="text-[var(--muted)]">The starting line</span><span className="text-[var(--green)]">●</span></div>
          <h2 className="text-2xl font-semibold tracking-tight">A clean slate.<br />A working foundation.</h2>
          <p className="mt-4 text-sm leading-6 text-[var(--muted)]">This is your starter, before the product exists. The actual brief, team assignments and provider access come next.</p>
          <SupabaseStatus />
          <ReadinessCheck />
        </aside>
      </section>
      <section aria-label="Kickoff steps" className="grid gap-5 border-t border-[var(--line)] pt-9 md:grid-cols-3">
        {steps.map(step => <article key={step.number} className="rounded-xl border border-[var(--line)] p-6">
          <p className="mb-8 text-xs text-[var(--green)]">/ {step.number}</p>
          <h2 className="text-xl font-semibold tracking-tight">{step.title}</h2>
          <p className="mt-3 min-h-20 text-sm leading-6 text-[var(--muted)]">{step.text}</p>
          <p className="mt-5 break-all border-t border-[var(--line)] pt-4 font-mono text-[10px] text-[var(--muted)]">{step.file}</p>
        </article>)}
      </section>
      <footer className="mt-12 flex flex-wrap justify-between gap-3 border-t border-[var(--line)] py-6 text-[10px] text-[var(--muted)]"><span>ONE TEAM. ONE BOARD. A CLEAR NEXT MOVE.</span><span>Build the smallest thing worth showing.</span></footer>
    </main>
  );
}
