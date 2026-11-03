import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";
import { cn } from "@/web/lib/cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const base = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[background-color,color,border-color,box-shadow,transform,opacity] duration-150 ease-out select-none disabled:pointer-events-none disabled:opacity-40 active:scale-[0.97] active:opacity-90 [&_svg]:shrink-0";
const variants: Record<Variant, string> = {
  primary: "bg-brand text-brand-fg hover:bg-brand-press",
  secondary: "bg-fill text-fg hover:bg-hover",
  outline: "border border-line-strong text-fg hover:bg-hover",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  danger: "bg-bad-soft text-bad hover:bg-bad/15",
};
const sizes: Record<Size, string> = {
  // Phone widths get 44 px touch targets (Apple HIG).
  sm: "h-8 px-3 text-[13px] max-sm:min-h-11 max-sm:px-3.5",
  md: "h-9 px-4 text-sm max-sm:min-h-11",
  lg: "h-11 px-5 text-[15px]",
  icon: "h-8 w-8 max-sm:min-h-11 max-sm:min-w-11",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(base, `ds-btn ds-btn-${variant}`, variants[variant], sizes[size], className); // DES1: class hooks, styled only under DESIGN_DES1
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, type = "button", ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});

export function ButtonLink({ variant = "primary", size = "md", className, ...rest }: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}
