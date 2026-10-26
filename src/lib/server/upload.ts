import { LIMITS } from "./config";
import { HttpError } from "./errors";
import { sniffType, type UploadInput } from "./pdf";

export interface ParsedUpload {
  files: (UploadInput & { name: string })[];
  fields: Record<string, string>;
}

function isFile(v: FormDataEntryValue): v is File {
  return typeof v === "object" && v !== null && "arrayBuffer" in v;
}

/**
 * Parse a multipart request. Files are read from the given field names in order; unknown types are rejected
 * (or skipped when `skipUnsupported`). Enforces per-file and per-request size caps.
 */
export async function parseUpload(
  req: Request,
  opts: { fileFields?: string[]; maxFiles?: number; skipUnsupported?: boolean; allowEmpty?: boolean } = {},
): Promise<ParsedUpload> {
  const fileFields = opts.fileFields ?? ["files[]", "files"];
  const maxFiles = opts.maxFiles ?? LIMITS.maxFilesPerRequest;
  const len = Number(req.headers.get("content-length") || "0");
  if (len > LIMITS.requestBytes) throw new HttpError(413, "payload_too_large", "Upload is too large (max 300 MB per request)");
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "unsupported_media_type", "Expected multipart/form-data");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "invalid_multipart", "Could not parse upload");
  }
  const fields: Record<string, string> = {};
  const files: ParsedUpload["files"] = [];
  let total = 0;
  for (const [key, value] of form.entries()) {
    if (isFile(value)) {
      if (!fileFields.includes(key)) continue;
      if (value.size === 0 && !value.name) continue;
      if (files.length >= maxFiles) throw new HttpError(413, "too_many_files", `At most ${maxFiles} files per request`);
      if (value.size > LIMITS.fileBytes) throw new HttpError(413, "file_too_large", "A file exceeds the 60 MB limit");
      total += value.size;
      if (total > LIMITS.requestBytes) throw new HttpError(413, "payload_too_large", "Upload is too large (max 300 MB per request)");
      const bytes = new Uint8Array(await value.arrayBuffer());
      const kind = sniffType(bytes);
      if (!kind) {
        if (opts.skipUnsupported) continue;
        throw new HttpError(415, "unsupported_type", `Unsupported file type: ${value.name || "file"} (use JPEG, PNG, WebP or PDF)`);
      }
      files.push({ kind, bytes, name: value.name || "" });
    } else if (typeof value === "string" && value.length <= 10_000) {
      fields[key] = value;
    }
  }
  if (files.length === 0 && !opts.allowEmpty) throw new HttpError(400, "no_files", "No files provided");
  return { files, fields };
}

export function titleFromFilename(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[_]+/g, " ").trim();
}
