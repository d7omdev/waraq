import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fresh, isolated data dir per test file, never a real data volume.
// Use /tmp explicitly: qpdf/gs AppArmor profiles deny hidden dirs (e.g. a TMPDIR under ~/.cache-like paths).
const dir = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "waraq-test-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-".padEnd(64, "x");
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
process.env.PUBLIC_BASE_URL = "https://scan.example.test";
process.env.WARAQ_AUTH_RATE_LIMIT = "0"; // enabled explicitly by the rate-limit test
// throwaway owner password for tests
process.env.TEST_OWNER_PASSWORD = "owner-pass-123";

const { createOwner } = await import("@/lib/server/setup");
await createOwner({ username: "tester", email: "tester@example.test", password: process.env.TEST_OWNER_PASSWORD });
