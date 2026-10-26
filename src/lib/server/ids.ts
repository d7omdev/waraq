import { nanoid } from "nanoid";
import { HttpError } from "./errors";

export const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export function newId(): string {
  return nanoid(16);
}

export function newShareToken(): string {
  return nanoid(24);
}

/** Validates an id coming from a URL/body. Ids are nanoid-alphabet only, so they are path-traversal safe. */
export function assertId(id: unknown, what = "Not found"): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new HttpError(404, "not_found", what);
  return id;
}

export function parseIndex(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) throw new HttpError(400, "invalid_page", "Invalid page index");
  return Number(raw);
}

export function nowIso(): string {
  return new Date().toISOString();
}
