import { z } from "zod";

export const idx = z.number().int().min(0).max(99_999);
const pages = z.array(idx).min(1).max(10_000);

export const pageOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rotate"), pages, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }),
  z.object({ op: z.literal("delete"), pages }),
  z.object({ op: z.literal("reorder"), order: z.array(idx).min(1).max(10_000) }),
  z.object({ op: z.literal("duplicate"), pages }),
]);

export const opsBody = z.object({ ops: z.array(pageOpSchema).min(1).max(200) });

const idStr = z.string().max(40);

export const docPatchBody = z.object({
  title: z.string().max(500).optional(),
  folderId: idStr.nullable().optional(),
  tags: z.array(z.string().max(200)).max(100).optional(),
  starred: z.boolean().optional(),
});

const flag = z.enum(["1", "0", "true", "false"]).transform((v) => v === "1" || v === "true");

export const listQuery = z.object({
  folderId: idStr.optional(),
  includeSubfolders: flag.optional(),
  q: z.string().max(300).optional(),
  tag: z.string().max(100).optional(),
  starred: flag.optional(),
  trash: flag.optional(),
  sort: z.enum(["updated", "created", "title", "size"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(300).optional(),
});

const color = z
  .string()
  .max(40)
  .regex(/^[#a-zA-Z0-9(),.%\s-]*$/, "Invalid color")
  .nullable()
  .optional();

export const folderCreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: idStr.nullable().optional(),
  color,
});

export const folderPatchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  parentId: idStr.nullable().optional(),
  color,
});

export const extractBody = z.object({
  pages,
  title: z.string().max(500).optional(),
  removeFromSource: z.boolean().optional(),
});

export const splitBody = z.union([
  z.object({ ranges: z.array(pages).min(1).max(1000) }),
  z.object({ every: z.number().int().min(1).max(10_000) }),
]);

export const mergeBody = z.object({
  ids: z.array(idStr).min(2).max(200),
  title: z.string().max(500).optional(),
  trashSources: z.boolean().optional(),
});

export const compressBody = z.object({ level: z.enum(["low", "medium", "high"]) });

const pagesList = z.union([
  z.array(idx).max(10_000),
  z
    .string()
    .max(60_000)
    .regex(/^\s*(\d+\s*(,\s*\d+\s*)*)?$/, "pages must be a comma-separated list of indexes")
    .transform((s) => (s.trim() ? s.split(",").map((x) => Number(x.trim())) : [])),
]);

const password = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !/[\r\n\u0000]/.test(s), "Password must not contain line breaks");

export const exportBody = z.object({
  format: z.enum(["pdf", "jpg-zip", "png-zip", "txt"]),
  pages: pagesList.optional(),
  password: z.union([password, z.literal("")]).optional(),
});

export const exportQuery = z.object({
  format: z.enum(["pdf", "jpg-zip", "png-zip", "txt"]).default("pdf"),
  pages: pagesList.optional(),
  password: z.string().optional(),
});

export const shareCreateBody = z.object({
  expiresIn: z.enum(["1h", "1d", "7d", "30d", "never"]),
  password: z.union([z.string().max(128), z.null()]).optional(),
  allowDownload: z.boolean().default(false),
});

export const unlockBody = z.object({ password: z.string().max(500) });

export const sharesListQuery = z.object({ status: z.enum(["active", "expired", "revoked", "all"]).default("all") });

export const sharePatchBody = z
  .object({
    expiresIn: z.enum(["1h", "1d", "7d", "30d", "never"]).optional(),
    password: z.union([password, z.literal(""), z.null()]).optional(),
    allowDownload: z.boolean().optional(),
  })
  .strict();

export const revokeAllBody = z.object({ docId: idStr.optional() }).strict();

export const ocrRerunBody = z
  .object({ ids: z.array(idStr).min(1).max(5000).optional(), all: z.boolean().optional() })
  .strict()
  .refine((b) => b.all === true || (b.ids && b.ids.length > 0), "Provide ids or all: true");
