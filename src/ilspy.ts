import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface IlspyOptions {
  /** Absolute path to ilspycmd.exe / ilspycmd. If omitted we'll resolve from PATH and the default dotnet tools dir. */
  binary?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const FALLBACK_PATHS = [
  // Windows: `dotnet tool install --global` lands here
  process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".dotnet", "tools", "ilspycmd.exe")
    : null,
  // POSIX
  process.env.HOME ? path.join(process.env.HOME, ".dotnet", "tools", "ilspycmd") : null,
].filter(Boolean) as string[];

let cachedBinary: string | null = null;

/**
 * Pick a working ilspycmd executable. We try (in order): explicit override,
 * ILSPYCMD env var, plain PATH lookup, then well-known dotnet tools paths.
 */
export function resolveIlspyBinary(override?: string): string {
  if (override) return override;
  if (cachedBinary) return cachedBinary;
  const envBin = process.env.ILSPYCMD;
  if (envBin && existsSync(envBin)) {
    cachedBinary = envBin;
    return cachedBinary;
  }
  /* Try PATH-resolved name first - on Windows the .exe extension matters. */
  const candidates = process.platform === "win32" ? ["ilspycmd.exe", "ilspycmd"] : ["ilspycmd"];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedBinary = c;
      return cachedBinary;
    }
  }
  for (const p of FALLBACK_PATHS) {
    if (existsSync(p)) {
      cachedBinary = p;
      return cachedBinary;
    }
  }
  /* Last resort: rely on PATH at spawn time. The error from spawn() will tell
   * the user to run `dotnet tool install --global ilspycmd`. */
  cachedBinary = candidates[0];
  return cachedBinary;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runIlspy(args: string[], opts: IlspyOptions = {}): Promise<RunResult> {
  const bin = resolveIlspyBinary(opts.binary);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ilspycmd timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "ilspycmd not found on PATH. Install with `dotnet tool install --global ilspycmd` " +
              "or set the ILSPYCMD env var to its absolute path."
          )
        );
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
