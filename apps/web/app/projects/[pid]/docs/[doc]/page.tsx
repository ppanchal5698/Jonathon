"use client";

import type { Project } from "@jonathon/contracts";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { Shell } from "@/components/shell";
import { DocumentView, type DocView } from "@/components/techdocs";
import { Loading, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/use-api";

export default function GeneratedDocumentPage() {
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Body />
      </Suspense>
    </Shell>
  );
}

function Body() {
  const { pid, doc } = useParams<{ pid: string; doc: string }>();
  const project = useApi<Project>(`/projects/${pid}`);
  const view = useApi<DocView>(`/projects/${pid}/documents/${doc}`);
  const title = view.data?.spec.title ?? "Document";
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[
          { label: project.data?.name ?? "Project", href: `/projects/${pid}` },
          { label: "Tech docs", href: `/projects/${pid}?tab=techdocs` },
          { label: title },
        ]}
      />
      <DocumentView pid={pid} doc={doc} />
    </>
  );
}
