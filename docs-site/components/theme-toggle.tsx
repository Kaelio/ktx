"use client";

import { useEffect, useState, type ComponentProps, type SVGProps } from "react";
import { useTheme } from "fumadocs-ui/provider/base";

/**
 * Two-icon theme switcher (light / dark), each icon selecting its own theme —
 * unlike fumadocs' default "light-dark" switcher, which is a single blind
 * toggle that flips on any click. Dropped into the sidebar footer pill via
 * `slots.themeSwitch`, so fumadocs passes the container className (left
 * divider, `ms-auto`, rounded inner buttons); we merge it onto our own base.
 *
 * Icons are inlined (the project doesn't depend on `lucide-react` directly);
 * `useTheme` is re-exported by fumadocs so we avoid a bare `next-themes` import.
 */
function SunIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

const OPTIONS = [
  ["light", SunIcon],
  ["system", MonitorIcon],
  ["dark", MoonIcon],
] as const;

function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function ThemeToggle({ className, ...props }: ComponentProps<"div">) {
  const { theme, setTheme } = useTheme();

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const active = mounted ? theme : null;

  return (
    <div
      className={cx(
        "inline-flex items-center overflow-hidden border",
        className,
      )}
      data-theme-toggle=""
      {...props}
    >
      {OPTIONS.map(([key, Icon]) => (
        <button
          key={key}
          type="button"
          aria-label={key}
          aria-pressed={active === key}
          onClick={() => setTheme(key)}
          className={cx(
            "size-6.5 p-1.5 transition-colors",
            active === key
              ? "bg-fd-accent text-fd-accent-foreground"
              : "text-fd-muted-foreground hover:text-fd-accent-foreground",
          )}
        >
          <Icon className="size-full" />
        </button>
      ))}
    </div>
  );
}
