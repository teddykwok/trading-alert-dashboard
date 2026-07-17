import { useEffect, useState } from "react";
import { classNames } from "../../utils/classNames";
import type { AlertStatus } from "../../types/alert";

interface ScreenshotPreviewProps {
  screenshotUrl: string | null;
  alt: string;
  className?: string;
  /**
   * Alert status, used to pick the right placeholder when there is no
   * screenshot: an ANALYZED alert always had one, so a missing URL there
   * means retention expired it — not that it is still pending.
   */
  status?: AlertStatus;
}

export function resolveScreenshotUrl(screenshotUrl: string): string {
  // Same base-URL rule as the API client: explicit VITE_API_URL wins, otherwise
  // same-origin ("/screenshots/…" via the Vite proxy). Never falls back to
  // localhost so screenshots load for remote (Tailscale) viewers too.
  const base = import.meta.env.VITE_API_URL?.trim() || "";
  return `${base}${screenshotUrl}`;
}

function Placeholder({ message, className }: { message: string; className?: string }) {
  return (
    <div
      className={classNames(
        "flex items-center justify-center rounded-lg border border-dashed border-surface-border bg-surface text-xs text-slate-500",
        className
      )}
    >
      {message}
    </div>
  );
}

export function ScreenshotPreview({ screenshotUrl, alt, className, status }: ScreenshotPreviewProps) {
  // A load error (e.g. the file was removed from disk but the URL not yet
  // cleared, or a transient network failure) renders the same neutral frame
  // instead of a broken-image icon. Reset when the URL changes.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [screenshotUrl]);

  if (!screenshotUrl) {
    const message =
      status === "ANALYZED" ? "Screenshot expired" : status === "FAILED" ? "No screenshot" : "Screenshot pending…";
    return <Placeholder message={message} className={className} />;
  }

  if (failed) {
    return <Placeholder message="Screenshot unavailable" className={className} />;
  }

  return (
    <img
      src={resolveScreenshotUrl(screenshotUrl)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={classNames("rounded-lg border border-surface-border object-cover", className)}
    />
  );
}
