import { z } from "zod";

export const driveConfigBody = z.object({
  clientId: z
    .string()
    .trim()
    .min(10)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, "Client ID looks wrong (copy it from Google Cloud → Clients)"),
  clientSecret: z.string().trim().min(8).max(200).regex(/^[\x21-\x7e]+$/, "Client secret looks wrong"),
});

export const driveSettingsBody = z.object({ autoSync: z.boolean().optional() });

export const driveSyncBody = z.object({
  ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,40}$/)).max(5000).optional(),
  all: z.boolean().optional(),
});
