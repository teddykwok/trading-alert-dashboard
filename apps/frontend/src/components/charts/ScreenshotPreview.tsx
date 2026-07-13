import { classNames } from "../../utils/classNames";

interface ScreenshotPreviewProps {
  screenshotUrl: string | null;
  alt: string;
  className?: string;
}

export function resolveScreenshotUrl(screenshotUrl: string): string {
  // Same base-URL rule as the API client: explicit VITE_API_URL wins, otherwise
  // same-origin ("/screenshots/…" via the Vite proxy). Never falls back to
  // localhost so screenshots load for remote (Tailscale) viewers too.
  const base = import.meta.env.VITE_API_URL?.trim() || "";
  return `${base}${screenshotUrl}`;
}

export function ScreenshotPreview({ screenshotUrl, alt, className }: ScreenshotPreviewProps) {
  if (!screenshotUrl) {
    return (
      <div
        className={classNames(
          "flex items-center justify-center rounded-lg border border-dashed border-surface-border bg-surface text-xs text-slate-500",
          className
        )}
      >
        Screenshot pending…
      </div>
    );
  }

  return (
    <img
      src={resolveScreenshotUrl(screenshotUrl)}
      alt={alt}
      className={classNames("rounded-lg border border-surface-border object-cover", className)}
    />
  );
}
