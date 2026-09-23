import type { SiteLogo as SiteLogoType } from "../../shared/settings";

export function SiteLogo({
  logo,
  className,
}: {
  logo: SiteLogoType;
  className?: string;
}) {
  if (logo === "none") return null;
  return (
    <svg
      className={className}
      width="32"
      height="32"
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      {logo === "emby" ? (
        <path fill="currentColor" d="M8 5h17v5H14v4h9v5h-9v3h11v5H8z" />
      ) : (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16 8C11 5 7 5 3 6v19c4-1 8-1 13 2m0-19c5-3 9-3 13-2v19c-4-1-8-1-13 2V8M7 11l5 1m-5 4 5 1m8-5 5-1m-5 6 5-1"
        />
      )}
    </svg>
  );
}
