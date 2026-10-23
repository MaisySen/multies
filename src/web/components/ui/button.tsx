import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Link, type LinkProps } from "react-router";
import { cn } from "@/web/lib/cn";
import { Spinner } from "./spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const base = "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-[background,color,border,box-shadow,transform] duration-150 select-none disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]";
const variants: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-white shadow-[0_1px_0_0_rgb(255_255_255/0.4)_inset]",
  secondary: "bg-elevated text-fg border border-line hover:bg-hover hover:border-line-strong",
  outline: "border border-line-strong text-fg hover:bg-elevated",
  ghost: "text-muted hover:text-fg hover:bg-elevated",
  danger: "bg-bad/90 text-white hover:bg-bad",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-[15px]",
  icon: "h-8 w-8",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
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
