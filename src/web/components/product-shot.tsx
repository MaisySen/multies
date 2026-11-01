import { cn } from "@/web/lib/cn";

/**
 * W1: a real product screenshot in light and dark. Only the copy for the current theme shows (index.css, mk-shot);
 * the other is display:none and lazy, so the browser does not download it.
 */
export function ProductShot({ name, alt, priority = false, className }: { name: string; alt: string; priority?: boolean; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-surface shadow-e3", className)} data-testid="product-shot">
      <img src={`/shots/${name}-light.webp`} alt={alt} width={1280} height={800} className="mk-shot-light block h-auto w-full" loading={priority ? "eager" : "lazy"} decoding="async" {...(priority ? { fetchPriority: "high" as const } : {})} />
      <img src={`/shots/${name}-dark.webp`} alt={alt} width={1280} height={800} className="mk-shot-dark h-auto w-full" loading="lazy" decoding="async" />
    </div>
  );
}
