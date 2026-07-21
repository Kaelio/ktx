"use client";

import { createContext, useContext, type ReactNode } from "react";
import { PageFooter, type FooterProps } from "fumadocs-ui/layouts/docs/page";
import { DocsPageActions } from "@/components/docs-page-actions";

type DocsPageFooterActions = {
  issueUrl: string;
  mdxSource: string;
  sourceEditUrl: string;
};

const docsPageFooterContext = createContext<DocsPageFooterActions | null>(null);

export function DocsPageFooterProvider({
  actions,
  children,
}: {
  actions: DocsPageFooterActions;
  children: ReactNode;
}) {
  return (
    <docsPageFooterContext.Provider value={actions}>
      {children}
    </docsPageFooterContext.Provider>
  );
}

export function DocsPageFooter(props: FooterProps) {
  const actions = useContext(docsPageFooterContext);

  return (
    <>
      {actions !== null && (
        <div className="mt-10 mb-4">
          <DocsPageActions
            mdxSource={actions.mdxSource}
            sourceEditUrl={actions.sourceEditUrl}
            issueUrl={actions.issueUrl}
          />
        </div>
      )}
      <PageFooter {...props} />
    </>
  );
}
