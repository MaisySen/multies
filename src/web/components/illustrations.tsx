/**
 * R35 Premium pass 2: small inline illustrations for empty lists, in brand blue, one per main list. Plain SVG (no
 * image request), currentColor-free so they read the same in light and dark: the soft fills use the brand at low
 * opacity on top of whatever surface sits behind.
 */
// R36: drawn in currentColor inside a text-brand frame, so every drawing follows the app's brand token in light and dark.
const B = "currentColor";

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" role="img" aria-label={label} className="mx-auto text-brand">
      <ellipse cx="60" cy="86" rx="38" ry="5" fill={B} opacity="0.08" />
      {children}
    </svg>
  );
}

export function InboxZeroArt() {
  return (
    <Frame label="An empty inbox tray">
      <rect x="22" y="30" width="76" height="46" rx="10" fill={B} opacity="0.12" />
      <path d="M22 54h20l6 9h24l6-9h20" fill="none" stroke={B} strokeWidth="3" strokeLinejoin="round" />
      <rect x="22" y="30" width="76" height="46" rx="10" fill="none" stroke={B} strokeWidth="3" />
      <path d="M50 18l6 6 14-14" fill="none" stroke={B} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </Frame>
  );
}

export function NoTasksArt() {
  return (
    <Frame label="A checklist with every item done">
      <rect x="30" y="14" width="60" height="66" rx="10" fill={B} opacity="0.12" />
      <rect x="30" y="14" width="60" height="66" rx="10" fill="none" stroke={B} strokeWidth="3" />
      {[32, 48, 64].map((y) => (
        <g key={y}>
          <circle cx="44" cy={y} r="5" fill={B} />
          <path d={`M41.5 ${y}l2 2 3.5-4`} fill="none" stroke="var(--color-surface, #fff)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="54" y={y - 2} width="26" height="4" rx="2" fill={B} opacity="0.35" />
        </g>
      ))}
    </Frame>
  );
}

export function NoChatArt() {
  return (
    <Frame label="Two speech bubbles">
      <rect x="18" y="20" width="56" height="36" rx="14" fill={B} opacity="0.14" />
      <rect x="18" y="20" width="56" height="36" rx="14" fill="none" stroke={B} strokeWidth="3" />
      <rect x="48" y="44" width="54" height="32" rx="14" fill={B} />
      {[64, 75, 86].map((x) => <circle key={x} cx={x} cy="60" r="3" fill="#fff" />)}
    </Frame>
  );
}

export function NoDocsArt() {
  return (
    <Frame label="A blank page with a pencil">
      <path d="M34 12h36l16 16v50a8 8 0 0 1-8 8H34a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8z" fill={B} opacity="0.12" />
      <path d="M34 12h36l16 16v50a8 8 0 0 1-8 8H34a8 8 0 0 1-8-8V20a8 8 0 0 1 8-8z" fill="none" stroke={B} strokeWidth="3" strokeLinejoin="round" />
      <path d="M70 12v16h16" fill="none" stroke={B} strokeWidth="3" strokeLinejoin="round" />
      <rect x="36" y="40" width="30" height="4" rx="2" fill={B} opacity="0.4" />
      <rect x="36" y="50" width="38" height="4" rx="2" fill={B} opacity="0.4" />
      <path d="M78 74l18-18 6 6-18 18h-6z" fill={B} />
    </Frame>
  );
}

export function ClearDayArt() {
  return (
    <Frame label="A sun over a clear horizon">
      <circle cx="60" cy="46" r="18" fill={B} opacity="0.9" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} x1={60 + Math.cos(a) * 25} y1={46 + Math.sin(a) * 25} x2={60 + Math.cos(a) * 32} y2={46 + Math.sin(a) * 32} stroke={B} strokeWidth="3" strokeLinecap="round" opacity="0.6" />;
      })}
      <rect x="20" y="72" width="80" height="4" rx="2" fill={B} opacity="0.3" />
    </Frame>
  );
}

/* R36: the rest of the lists that can be empty. Same 120 x 96 frame, a soft fill at 12 % under a 3 px line, one accent. */

export function MailFolderArt() {
  return (
    <Frame label="An empty mail folder">
      <rect x="24" y="26" width="72" height="50" rx="9" fill={B} opacity="0.12" />
      <rect x="24" y="26" width="72" height="50" rx="9" fill="none" stroke={B} strokeWidth="3" />
      <path d="M26 30l34 24 34-24" fill="none" stroke={B} strokeWidth="3" strokeLinejoin="round" />
    </Frame>
  );
}

export function NoSearchResultsArt() {
  return (
    <Frame label="A magnifying glass that found nothing">
      <circle cx="54" cy="44" r="22" fill={B} opacity="0.12" />
      <circle cx="54" cy="44" r="22" fill="none" stroke={B} strokeWidth="3" />
      <path d="M70 60l16 16" stroke={B} strokeWidth="5" strokeLinecap="round" />
      <path d="M45 44h18" stroke={B} strokeWidth="3" strokeLinecap="round" opacity="0.6" />
    </Frame>
  );
}

export function NoMeetingsArt() {
  return (
    <Frame label="A video camera beside a calendar page">
      <rect x="18" y="28" width="54" height="40" rx="9" fill={B} opacity="0.12" />
      <rect x="18" y="28" width="54" height="40" rx="9" fill="none" stroke={B} strokeWidth="3" />
      <path d="M72 42l18-10v32l-18-10z" fill={B} opacity="0.35" stroke={B} strokeWidth="3" strokeLinejoin="round" />
      <circle cx="45" cy="48" r="6" fill={B} />
    </Frame>
  );
}

export function NoContactsArt() {
  return (
    <Frame label="Two contact cards">
      <rect x="34" y="18" width="56" height="40" rx="9" fill={B} opacity="0.1" stroke={B} strokeWidth="2" strokeOpacity="0.4" />
      <rect x="22" y="32" width="62" height="44" rx="10" fill={B} opacity="0.12" />
      <rect x="22" y="32" width="62" height="44" rx="10" fill="none" stroke={B} strokeWidth="3" />
      <circle cx="40" cy="50" r="7" fill={B} />
      <path d="M30 68c2-6 6-8 10-8s8 2 10 8" fill="none" stroke={B} strokeWidth="3" strokeLinecap="round" />
      <rect x="56" y="46" width="20" height="4" rx="2" fill={B} opacity="0.4" />
      <rect x="56" y="56" width="14" height="4" rx="2" fill={B} opacity="0.4" />
    </Frame>
  );
}

export function CaughtUpArt() {
  return (
    <Frame label="A bell with a check mark">
      <path d="M60 16c-13 0-22 10-22 23v15l-6 10h56l-6-10V39c0-13-9-23-22-23z" fill={B} opacity="0.12" />
      <path d="M60 16c-13 0-22 10-22 23v15l-6 10h56l-6-10V39c0-13-9-23-22-23z" fill="none" stroke={B} strokeWidth="3" strokeLinejoin="round" />
      <path d="M53 70a7 7 0 0014 0" fill="none" stroke={B} strokeWidth="3" />
      <circle cx="82" cy="24" r="10" fill={B} />
      <path d="M77.5 24l3 3 5.5-6" fill="none" stroke="var(--color-surface, #fff)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </Frame>
  );
}

export function NoSprintsArt() {
  return (
    <Frame label="A flag at the end of a track">
      <path d="M18 72c18-4 30-18 44-26s26-8 38-6" fill="none" stroke={B} strokeWidth="3" strokeLinecap="round" strokeDasharray="2 7" />
      <circle cx="18" cy="72" r="5" fill={B} opacity="0.35" />
      <path d="M86 58V18" stroke={B} strokeWidth="3" strokeLinecap="round" />
      <path d="M86 20h-26l6 9-6 9h26z" fill={B} opacity="0.12" stroke={B} strokeWidth="3" strokeLinejoin="round" />
    </Frame>
  );
}

export function EmptyBoardArt() {
  return (
    <Frame label="Three empty board columns">
      {[20, 48, 76].map((x, i) => (
        <g key={x}>
          <rect x={x} y="16" width="24" height="60" rx="6" fill={B} opacity="0.1" />
          <rect x={x + 3} y={22} width="18" height={i === 1 ? 14 : 10} rx="3" fill={B} opacity={i === 1 ? 0.5 : 0.25} />
        </g>
      ))}
      <path d="M60 52v12M54 58h12" stroke={B} strokeWidth="3" strokeLinecap="round" />
    </Frame>
  );
}

/** A smaller drawing for tight spots (the command menu's no result row). */
export function SmallNoResultsArt() {
  return (
    <svg width="48" height="40" viewBox="0 0 48 40" aria-hidden className="mx-auto text-brand">
      <circle cx="20" cy="17" r="10" fill="currentColor" opacity="0.12" stroke="currentColor" strokeWidth="2.5" />
      <path d="M28 25l8 8" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
