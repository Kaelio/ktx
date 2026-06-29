"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type SVGProps,
} from "react";
import { useTheme } from "fumadocs-ui/provider/base";

/**
 * Three-icon theme switcher (light / system / dark) rendered as a radio group —
 * each icon selects its own theme, unlike fumadocs' default "light-dark"
 * switcher, which is a single blind toggle that flips on any click. Reads
 * `theme`, not `resolvedTheme`, so the "system" option can show as selected
 * (resolvedTheme collapses system to light/dark). Dropped into the sidebar
 * footer pill via `slots.themeSwitch`, so fumadocs passes the container
 * className (left divider, `ms-auto`, rounded inner buttons); we merge it onto
 * our own base.
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
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme : null;

  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // Pre-mount nothing is selected, so keep the first control tabbable.
  const selectedIndex = OPTIONS.findIndex(([key]) => key === active);
  const rovingIndex = selectedIndex === -1 ? 0 : selectedIndex;

  // Radio-group keyboard model: arrows move focus and pick that theme.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + OPTIONS.length) % OPTIONS.length;
    setTheme(OPTIONS[next][0]);
    buttonsRef.current[next]?.focus();
  }

  return (
    <div
      className={cx("inline-flex items-center overflow-hidden border", className)}
      data-theme-toggle=""
      role="radiogroup"
      aria-label="Theme"
      {...props}
    >
      {OPTIONS.map(([key, Icon], index) => (
        <button
          key={key}
          ref={(el) => {
            buttonsRef.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-label={key}
          aria-checked={active === key}
          tabIndex={index === rovingIndex ? 0 : -1}
          onClick={() => setTheme(key)}
          onKeyDown={(event) => onKeyDown(event, index)}
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
