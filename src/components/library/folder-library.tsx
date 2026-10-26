"use client";

import { useParams } from "next/navigation";
import { LibraryView } from "./library-view";

export function FolderLibrary() {
  const { id } = useParams<{ id: string }>();
  return <LibraryView key={id} mode="folder" folderId={id} />;
}
