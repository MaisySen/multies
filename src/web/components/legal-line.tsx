import { LEGAL_ENTITY, LEGAL_LINE } from "@/shared/legal-entity"; // R74: not the full documents

/** The company's standard legal line, with the company name linked to its website. */
export function LegalLine({ className }: { className?: string }) {
  return (
    <span className={className} data-testid="legal-line">
      {LEGAL_LINE.before}
      <a href={LEGAL_ENTITY.website} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-fg">{LEGAL_LINE.company}</a>
      {LEGAL_LINE.after}
    </span>
  );
}
