"use client";

import { api } from "@/lib/client/api";
import { invalidate, useQuery } from "@/lib/client/query";
import type { Folder } from "@/lib/types";

export const FOLDERS_KEY = "/api/folders";
export const TAGS_KEY = "/api/tags";

export function useFolders() {
  return useQuery<Folder[]>(FOLDERS_KEY, api.folders);
}

export function useTags() {
  return useQuery<{ tag: string; count: number }[]>(TAGS_KEY, api.tags);
}

/** Refetch every document list + folder counts + tags after a mutation. */
export function refreshLibrary() {
  invalidate((k) => k.startsWith("/api/docs?") || k === "/api/docs" || k === FOLDERS_KEY || k === TAGS_KEY);
}

export function docKey(id: string) {
  return `/api/docs/${id}`;
}

export function refreshDoc(id: string) {
  invalidate((k) => k === docKey(id) || k.startsWith(`${docKey(id)}/`));
}

export function folderPath(folders: Folder[] | undefined, id: string | null): Folder[] {
  if (!folders || !id) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

export interface FolderNode extends Folder {
  depth: number;
}

/** Depth-first flattened tree, sorted by name. */
export function flattenFolders(folders: Folder[] | undefined): FolderNode[] {
  if (!folders) return [];
  const children = new Map<string | null, Folder[]>();
  const ids = new Set(folders.map((f) => f.id));
  for (const f of folders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(f);
    children.set(parent, list);
  }
  const out: FolderNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const f of list) {
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export const FOLDER_COLORS = ["#a1a1aa", "#8b8cf0", "#6fa8dc", "#6bbf8e", "#c9a35a", "#d98a6c", "#c98aa8"];
