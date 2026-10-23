import { cn } from "@/web/lib/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("h-7 w-7", className)} aria-hidden>
      <defs>
        <linearGradient id="lm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b88ff" />
          <stop offset="1" stopColor="#5450f0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lm)" />
      <path d="M8 11.5 16 17l8-5.5M9 10h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1z" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoMark />
      <span className="text-[17px]">MyMail</span>
    </span>
  );
}
