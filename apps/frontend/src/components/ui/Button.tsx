import type { ButtonHTMLAttributes } from "react";
import { classNames } from "../../utils/classNames";

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-blue-600 hover:bg-blue-500 text-white",
  secondary: "bg-surface-border hover:bg-slate-700 text-slate-100",
  danger: "bg-red-600/90 hover:bg-red-500 text-white",
  ghost: "bg-transparent hover:bg-surface-border text-slate-300",
};

export function Button({ variant = "primary", className, ...props }: ButtonProps) {
  return (
    <button
      className={classNames(
        "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        VARIANT_CLASSES[variant],
        className
      )}
      {...props}
    />
  );
}
