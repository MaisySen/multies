/**
 * R35 Premium pass 2: small inline illustrations for empty lists, in brand blue, one per main list. Plain SVG (no
 * image request), currentColor-free so they read the same in light and dark: the soft fills use the brand at low
 * opacity on top of whatever surface sits behind.
 */
const B = "#0071E3";

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" role="img" aria-label={label} className="mx-auto">
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
          <path d={`M41.5 ${y}l2 2 3.5-4`} fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
