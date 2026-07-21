"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

type Props = {
  title: string;
  markdownHref: string;
};

export function DocsPageActions({ title, markdownHref }: Props) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const onCopy = async () => {
    try {
      const response = await fetch(markdownHref, {
        headers: { Accept: "text/markdown" },
      });
      if (!response.ok) {
        throw new Error(`Markdown request failed: ${response.status}`);
      }

      await navigator.clipboard.writeText(await response.text());
      setCopied(true);
      setOpen(false);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied or Markdown unavailable - fail silently.
    }
  };

  const publicMarkdownUrl = `https://docs.kaelio.com/ktx${markdownHref}`;
  const assistantPrompt =
    `Use this documentation page to answer questions about ${title}: ${publicMarkdownUrl}`;
  const chatGptHref =
    `https://chatgpt.com/?q=${encodeURIComponent(assistantPrompt)}`;
  const claudeHref =
    `https://claude.ai/new?q=${encodeURIComponent(assistantPrompt)}`;

  return (
    <div ref={rootRef} className="not-prose relative text-sm">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-fd-border bg-fd-background px-3 font-medium text-fd-foreground shadow-sm transition-colors hover:border-fd-primary/40"
        data-state={copied ? "copied" : "idle"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span>{copied ? "Copied" : "Copy page"}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute right-0 top-11 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-fd-border bg-fd-popover p-1.5 text-fd-popover-foreground shadow-sm"
        >
          <ActionButton
            icon={<CopyIcon />}
            title="Copy page"
            description="Copy page as Markdown for LLMs"
            onClick={onCopy}
          />
          <ActionLink
            icon={<MarkdownIcon />}
            title="View as Markdown"
            description="View this page as plain text"
            href={markdownHref}
            onClick={() => setOpen(false)}
          />
          <ActionLink
            icon={<OpenAiIcon />}
            title="Open in ChatGPT"
            description="Ask questions about this page"
            href={chatGptHref}
            onClick={() => setOpen(false)}
          />
          <ActionLink
            icon={<ClaudeIcon />}
            title="Open in Claude"
            description="Ask questions about this page"
            href={claudeHref}
            onClick={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-fd-muted focus:bg-fd-muted focus:outline-none"
    >
      <ActionIcon>{icon}</ActionIcon>
      <ActionText title={title} description={description} />
    </button>
  );
}

function ActionLink({
  icon,
  title,
  description,
  href,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
  onClick: () => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left no-underline transition-colors hover:bg-fd-muted focus:bg-fd-muted focus:outline-none"
    >
      <ActionIcon>{icon}</ActionIcon>
      <ActionText title={title} description={description} external />
    </a>
  );
}

function ActionIcon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-fd-border text-fd-muted-foreground">
      {children}
    </span>
  );
}

function ActionText({
  title,
  description,
  external,
}: {
  title: string;
  description: string;
  external?: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className="flex items-center gap-1.5 font-semibold leading-5">
        {title}
        {external && <ExternalIcon />}
      </span>
      <span className="block truncate text-sm leading-5 text-fd-muted-foreground">
        {description}
      </span>
    </span>
  );
}

function CopyIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={open ? "rotate-180 transition-transform" : "transition-transform"}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function MarkdownIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 14V10l2.5 3L12 10v4" />
      <path d="M15 10v4" />
      <path d="M13.5 12.5 15 14l1.5-1.5" />
    </svg>
  );
}

function OpenAiIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.522 10.278a5.298 5.298 0 0 0-.456-4.349 5.35 5.35 0 0 0-5.759-2.566 5.357 5.357 0 0 0-9.091 1.923 5.296 5.296 0 0 0-3.54 2.567 5.35 5.35 0 0 0 .657 6.28 5.296 5.296 0 0 0 .452 4.349 5.35 5.35 0 0 0 5.763 2.566 5.296 5.296 0 0 0 4.434 2.306 5.35 5.35 0 0 0 5.11-3.72 5.296 5.296 0 0 0 3.54-2.566 5.35 5.35 0 0 0-1.11-6.79Zm-7.54 11.69a3.91 3.91 0 0 1-2.51-.91l.124-.07 4.17-2.408a.72.72 0 0 0 .36-.624v-5.881l1.762 1.017c.032.016.054.048.058.084v4.87a3.97 3.97 0 0 1-3.964 3.923ZM3.99 17.79a3.91 3.91 0 0 1-.467-2.626l.124.074 4.174 2.41a.72.72 0 0 0 .72 0l5.093-2.94v2.034a.104.104 0 0 1-.042.09l-4.216 2.434A3.97 3.97 0 0 1 3.99 17.79ZM2.88 8.548A3.91 3.91 0 0 1 4.923 6.83v4.958a.72.72 0 0 0 .36.623l5.094 2.94-1.762 1.018a.104.104 0 0 1-.1.008L4.298 13.94A3.97 3.97 0 0 1 2.88 8.548Zm15.838 3.04-5.093-2.94 1.762-1.016a.104.104 0 0 1 .1-.008l4.216 2.434a3.97 3.97 0 0 1-.625 7.111v-4.958a.72.72 0 0 0-.36-.623Zm1.759-2.752-.124-.074-4.174-2.41a.72.72 0 0 0-.72 0l-5.093 2.94V7.258c0-.036.018-.07.047-.09l4.216-2.434a3.97 3.97 0 0 1 5.848 4.102ZM8.873 11.925 7.11 10.908a.104.104 0 0 1-.058-.084v-4.87a3.97 3.97 0 0 1 6.474-3.014l-.124.07-4.17 2.408a.72.72 0 0 0-.36.624v5.883Zm1.492-1.08 2.268-1.31 2.268 1.31v2.62l-2.268 1.31-2.268-1.31v-2.62Z" />
    </svg>
  );
}

function ClaudeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}
