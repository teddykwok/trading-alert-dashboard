import { classNames } from "../../utils/classNames";

interface ScreenshotPreviewProps {
  screenshotUrl: string | null;
  alt: string;
  className?: string;
}

export function resolveScreenshotUrl(screenshotUrl: string): string {
  return `${import.meta.env.VITE_API_URL}${screenshotUrl}`;
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
