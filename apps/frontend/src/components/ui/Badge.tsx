import type { HTMLAttributes } from "react";
import { classNames } from "../../utils/classNames";

type Tone = "green" | "red" | "yellow" | "gray" | "blue";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-green-500/15 text-green-400 border-green-500/30",
  red: "bg-red-500/15 text-red-400 border-red-500/30",
  yellow: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  gray: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  blue: "bg-blue-500/15 text-blue-400 border-blue-500/30",
};

export function Badge({ tone = "gray", className, ...props }: BadgeProps) {
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tracking-wide",
        TONE_CLASSES[tone],
        className
      )}
      {...props}
    />
  );
}
