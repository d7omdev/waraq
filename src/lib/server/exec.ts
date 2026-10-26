import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * gs/qpdf run under AppArmor profiles that only allow temp files in /tmp (and data files in non-hidden
 * $HOME paths or /mnt). Force a permitted TMPDIR for children (ocrmypdf → gs/tesseract included).
 */
function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra ?? {}), TMPDIR: process.env.WARAQ_CHILD_TMPDIR || "/tmp" };
}

/** Spawn a process without a shell. Never pass secrets as argv (use files). */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxStdout?: number; cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const { timeoutMs = 120_000, maxStdout = 64 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv(opts.env) });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outLen += d.length;
      if (outLen <= maxStdout) out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 8000) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export async function runOk(cmd: string, args: string[], opts?: Parameters<typeof run>[2]): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  return r;
}

const avail = new Map<string, boolean>();
export async function hasCommand(cmd: string): Promise<boolean> {
  if (avail.has(cmd)) return avail.get(cmd)!;
  let ok = false;
  try {
    const r = await run(cmd, [cmd.startsWith("pdfto") ? "-v" : "--version"], { timeoutMs: 20_000 });
    ok = r.code === 0;
  } catch {
    ok = false;
  }
  avail.set(cmd, ok);
  return ok;
}
