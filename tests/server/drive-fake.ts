import { createHash } from "node:crypto";

// In-memory fake of the Google OAuth token endpoint + the Drive v3 REST subset Waraq uses.
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
  content?: Buffer;
  ocrLanguage?: string;
}

type Handler = (req: { method: string; url: URL; headers: Headers; body: Buffer }) => Response | null | undefined;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

export class FakeGoogle {
  files = new Map<string, FakeFile>();
  validTokens = new Set<string>();
  refreshTokens = new Set<string>(["rt-good"]);
  log: string[] = [];
  tokenCalls = 0;
  revoked: string[] = [];
  /** one-shot interceptors, consumed in order when they return a Response */
  intercept: Handler[] = [];
  throwAll = false;
  /** Drive OCR: text returned when a converted Google Doc is exported */
  ocrResult: (f: FakeFile) => string = (f) => `\uFEFFDRIVE TEXT [${f.ocrLanguage}] ${f.content?.length ?? 0}`;
  deleted: string[] = [];
  downloads = 0;
  private seq = 0;
  private sessions = new Map<string, { fileId: string | null; meta: Record<string, unknown>; query: URLSearchParams }>();

  constructor() {
    this.files.set("root", { id: "root", name: "My Drive", mimeType: "folder", parents: [], trashed: false, appProperties: {} });
  }

  byName(name: string) {
    return [...this.files.values()].filter((f) => f.name === name);
  }
  pdfs() {
    return [...this.files.values()].filter((f) => f.mimeType === "application/pdf");
  }

  private view(f: FakeFile) {
    const extra = f.content ? { md5Checksum: createHash("md5").update(f.content).digest("hex"), size: String(f.content.length) } : {};
    return { id: f.id, name: f.name, parents: f.parents, trashed: f.trashed, webViewLink: `https://drive.google.com/file/d/${f.id}/view`, ...extra };
  }

  private applyMove(f: FakeFile, qs: URLSearchParams) {
    const rm = qs.get("removeParents");
    const add = qs.get("addParents");
    if (rm) f.parents = f.parents.filter((p) => !rm.split(",").includes(p));
    if (add) {
      if (!this.files.has(add)) return false;
      f.parents = [...new Set([...f.parents, add])];
    }
    return true;
  }

  private parseMultipart(contentType: string, body: Buffer): { meta: Record<string, unknown>; content: Buffer } {
    const boundary = /boundary=([^;]+)/.exec(contentType)![1];
    const sep = Buffer.from(`--${boundary}`);
    const p1 = body.indexOf(sep) + sep.length;
    const h1 = body.indexOf("\r\n\r\n", p1) + 4;
    const p2 = body.indexOf(sep, h1);
    const meta = JSON.parse(body.subarray(h1, p2 - 2).toString("utf8"));
    const h2 = body.indexOf("\r\n\r\n", p2) + 4;
    const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
    return { meta, content: Buffer.from(body.subarray(h2, end)) };
  }

  private writeFile(fileId: string | null, meta: Record<string, unknown>, qs: URLSearchParams, content?: Buffer): Response {
    if (fileId) {
      const f = this.files.get(fileId);
      if (!f) return json({ error: { code: 404, message: `File not found: ${fileId}.` } }, 404);
      if (!this.applyMove(f, qs)) return json({ error: { code: 404, message: "File not found: parent." } }, 404);
      if (typeof meta.name === "string") f.name = meta.name;
      if (typeof meta.trashed === "boolean") f.trashed = meta.trashed;
      if (content) f.content = content;
      return json(this.view(f));
    }
    const parents = (meta.parents as string[]) ?? ["root"];
    if (!parents.every((p) => this.files.has(p) && !this.files.get(p)!.trashed)) {
      return json({ error: { code: 404, message: "File not found: parent." } }, 404);
    }
    const id = `f${++this.seq}`;
    const f: FakeFile = {
      id,
      name: String(meta.name),
      mimeType: String(meta.mimeType ?? "application/octet-stream"),
      parents,
      trashed: false,
      appProperties: (meta.appProperties as Record<string, string>) ?? {},
      content,
      ocrLanguage: qs.get("ocrLanguage") ?? undefined,
    };
    this.files.set(id, f);
    return json(this.view(f));
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    if (this.throwAll) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const raw = init.body;
    const body = raw == null ? Buffer.alloc(0) : typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
    this.log.push(`${method} ${url.origin}${url.pathname}${url.search ? `?${url.searchParams.get("uploadType") ?? ""}` : ""}`);

    for (let i = 0; i < this.intercept.length; i++) {
      const r = this.intercept[i]({ method, url, headers, body });
      if (r) {
        this.intercept.splice(i, 1);
        return r;
      }
    }

    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      this.tokenCalls++;
      const p = new URLSearchParams(body.toString());
      if (p.get("client_secret") !== "secret-123") return json({ error: "invalid_client" }, 401);
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code") return json({ error: "invalid_grant", error_description: "Bad code" }, 400);
        const at = `at-${++this.seq}`;
        this.validTokens.add(at);
        return json({ access_token: at, expires_in: 3599, refresh_token: "rt-good", token_type: "Bearer" });
      }
      if (!this.refreshTokens.has(p.get("refresh_token") ?? "")) return json({ error: "invalid_grant" }, 400);
      const at = `at-${++this.seq}`;
      this.validTokens.add(at);
      return json({ access_token: at, expires_in: 3599 });
    }
    if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) {
      this.revoked.push(new URLSearchParams(body.toString()).get("token") ?? "");
      return new Response("", { status: 200 });
    }

    const auth = headers.get("authorization")?.replace(/^Bearer /, "");
    if (!auth || !this.validTokens.has(auth)) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);

    const path = url.pathname;
    if (path === "/drive/v3/about") return json({ user: { emailAddress: "owner@example.com", displayName: "Owner" } });

    if (path === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      let list = [...this.files.values()].filter((f) => f.id !== "root");
      const ap = /appProperties has \{ key='(\w+)' and value='(\w+)' \}/.exec(q);
      if (ap) list = list.filter((f) => f.appProperties[ap[1]] === ap[2]);
      const inParents = /'([^']+)' in parents/.exec(q);
      if (inParents) list = list.filter((f) => f.parents.includes(inParents[1]));
      if (q.includes("trashed = false")) list = list.filter((f) => !f.trashed);
      return json({ files: list.map((f) => this.view(f)) });
    }
    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (fm && method === "GET") {
      const f = this.files.get(fm[1]);
      if (!f) return json({ error: { code: 404, message: "File not found" } }, 404);
      if (url.searchParams.get("alt") === "media") {
        this.downloads++;
        return new Response(new Uint8Array(f.content ?? Buffer.alloc(0)), { status: 200, headers: { "content-type": f.mimeType } });
      }
      return json(this.view(f));
    }
    const em = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
    if (em && method === "GET") {
      const f = this.files.get(em[1]);
      if (!f) return json({ error: { code: 404, message: "File not found" } }, 404);
      if (f.mimeType !== "application/vnd.google-apps.document") return json({ error: { code: 403, message: "Export only supports Docs Editors files." } }, 403);
      return new Response(this.ocrResult(f), { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (fm && method === "DELETE") {
      if (!this.files.delete(fm[1])) return json({ error: { code: 404, message: "File not found" } }, 404);
      this.deleted.push(fm[1]);
      return new Response(null, { status: 204 });
    }
    if (path === "/drive/v3/files" && method === "POST") return this.writeFile(null, JSON.parse(body.toString()), url.searchParams);
    if (fm && method === "PATCH") return this.writeFile(fm[1], JSON.parse(body.toString()), url.searchParams);

    const um = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path);
    if (um) {
      const fileId = um[1] ?? null;
      const type = url.searchParams.get("uploadType");
      if (method === "PUT" && url.searchParams.get("upload_id")) {
        const s = this.sessions.get(url.searchParams.get("upload_id")!);
        if (!s) return json({ error: { code: 404, message: "no session" } }, 404);
        return this.writeFile(s.fileId, s.meta, s.query, body);
      }
      if (type === "multipart") {
        const { meta, content } = this.parseMultipart(headers.get("content-type") ?? "", body);
        return this.writeFile(fileId, meta, url.searchParams, content);
      }
      if (type === "resumable") {
        const sid = `u${++this.seq}`;
        this.sessions.set(sid, { fileId, meta: JSON.parse(body.toString()), query: url.searchParams });
        return new Response("", { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sid}` } });
      }
    }
    return json({ error: { code: 400, message: `fake: unhandled ${method} ${path}` } }, 400);
  };
}

export { json as fakeJson };
