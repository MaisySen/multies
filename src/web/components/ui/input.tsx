import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "@/web/lib/cn";

// 16 px text on phones stops iOS Safari zooming into a focused field.
const field = "w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-subtle transition-[border-color,box-shadow] duration-150 ease-out focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/15 disabled:opacity-60 aria-[invalid=true]:border-bad aria-[invalid=true]:focus:ring-bad/15 max-sm:text-base";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(field, "h-10 max-sm:h-11", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(field, "py-2.5 leading-relaxed", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(field, "h-10 max-sm:h-11 appearance-none bg-[url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%238e8e93' stroke-width='1.6'><path d='M3 4.5 6 7.5 9 4.5'/></svg>\")] bg-[right_12px_center] bg-no-repeat pr-9", className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className }: {
  label: string; hint?: ReactNode; error?: string; className?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-[13px] font-medium text-fg/90">{label}</label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? descId : undefined })}
      {(error || hint) && (
        <p id={descId} role={error ? "alert" : undefined} className={cn("flex items-start gap-1 text-xs", error ? "text-bad" : "text-subtle")}>{error ?? hint}</p>
      )}
    </div>
  );
}
