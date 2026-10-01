type IconName =
  | "search"
  | "sun"
  | "moon"
  | "arrow"
  | "chevron"
  | "book"
  | "menu"
  | "close"
  | "clock";

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  const paths: Record<IconName, string> = {
    search: "m21 21-4.6-4.6M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
    sun: "M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    moon: "M20.9 13a9 9 0 1 1-9.9-9.9A7 7 0 0 0 20.9 13Z",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    chevron: "m9 5 7 7-7 7",
    book: "M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1m0-15c3-2 6-2 10-1v15c-4-1-7-1-10 1V5",
    menu: "M4 6h16M4 12h16M4 18h16",
    close: "m6 6 12 12M6 18 18 6",
    clock: "M12 8v4l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  };
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
