"use client";

import { useState, type SVGProps } from "react";

type Props = {
  mdxSource?: string;
  issueUrl?: string;
  sourceEditUrl?: string;
};

function stripFrontmatter(source: string) {
  return source.trim().replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function EditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function MessageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    </svg>
  );
}

const actionClassName =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-fd-border bg-fd-background px-3 font-medium text-fd-muted-foreground transition-colors hover:border-fd-primary/40 hover:text-fd-foreground";

export function DocsPageActions({ mdxSource, issueUrl, sourceEditUrl }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (mdxSource === undefined) return;

    try {
      await navigator.clipboard.writeText(stripFrontmatter(mdxSource));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied - fail silently
    }
  };

  return (
    <div className="not-prose flex flex-wrap items-center gap-2 text-xs">
      {mdxSource !== undefined && (
        <button
          type="button"
          onClick={onCopy}
          className={`${actionClassName} data-[state=copied]:border-emerald-500/40 data-[state=copied]:text-emerald-600`}
          data-state={copied ? "copied" : "idle"}
        >
          <CopyIcon className="size-3.5" aria-hidden="true" />
          {copied ? "Copied" : "Copy as Markdown"}
        </button>
      )}
      {sourceEditUrl !== undefined && (
        <a
          href={sourceEditUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={actionClassName}
        >
          <EditIcon className="size-3.5" aria-hidden="true" />
          Suggest edits
        </a>
      )}
      {issueUrl !== undefined && (
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer noopener"
          className={actionClassName}
        >
          <MessageIcon className="size-3.5" aria-hidden="true" />
          Raise issue
        </a>
      )}
    </div>
  );
}
