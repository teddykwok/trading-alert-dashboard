import type { HTMLAttributes } from "react";
import { classNames } from "../../utils/classNames";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={classNames(
        "rounded-xl border border-surface-border bg-surface-raised shadow-sm",
        className
      )}
      {...props}
    />
  );
}
