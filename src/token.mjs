import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "deepai-bridge");
export const CACHE_FILE = path.join(CONFIG_DIR, "token.json");

const ENV_KEYS = ["T3_DEEPAI_TOKEN", "DEEPAI_TRANSPORT_TOKEN"];

// Reads the environment block of other same-user processes (KERN_PROCARGS2).
// `ps eww` no longer prints env on modern macOS, so this is the only way to see
// the transport token the DeepAI Code server hands to its `pi` child process.
const SYSCTL_SCRIPT = `
import ctypes, ctypes.util, sys
KERN_PROCARGS2 = 49
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
want = set(sys.argv[1].split(","))
rows = []
for arg in sys.argv[2:]:
    try:
        pid = int(arg)
        mib = (ctypes.c_int * 3)(1, KERN_PROCARGS2, pid)
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
            continue
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
            continue
    except Exception:
        continue
    for part in buf.raw[: size.value][4:].split(b"\\0"):
        text = part.decode("utf-8", "replace")
        key, sep, value = text.partition("=")
        if sep and key in want and value:
            rows.append("%d\\t%s=%s" % (pid, key, value))
print("\\n".join(rows))
`;

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (raw && typeof raw.token === "string" && raw.token.length > 0) {
      return { token: raw.token, source: "cache" };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(token, pid) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ token, pid: pid ?? null, discoveredAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    fs.chmodSync(CACHE_FILE, 0o600);
  } catch {
    /* cache is best effort */
  }
}

function candidatePids() {
  let ps = "";
  try {
    ps = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of ps.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (/(^|\/)pi(\s|$)/.test(command) || /pi-coding-agent/.test(command)) {
      pids.push(Number(pid));
    }
  }
  return pids;
}

function scanProcesses() {
  const pids = candidatePids();
  if (pids.length === 0) return null;
  let out = "";
  try {
    out = execFileSync("python3", ["-c", SYSCTL_SCRIPT, ENV_KEYS.join(","), ...pids.map(String)], {
      encoding: "utf8",
      timeout: 15000,
    });
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    const [pid, assignment] = line.split("\t");
    const eq = (assignment ?? "").indexOf("=");
    if (eq === -1) continue;
    const token = assignment.slice(eq + 1).trim();
    if (token.length >= 16) return { token, pid: Number(pid) || null };
  }
  return null;
}

export function resolveToken({ refresh = false, allowCacheOnly = false } = {}) {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return { token: value.trim(), source: `env:${key}` };
    }
  }

  const cached = readCache();
  if (cached && !refresh) return cached;
  if (allowCacheOnly) {
    if (cached) return cached;
    throw new Error("No cached DeepAI transport token found.");
  }

  const scanned = scanProcesses();
  if (scanned) {
    writeCache(scanned.token, scanned.pid);
    return { token: scanned.token, source: `process:${scanned.pid ?? "?"}` };
  }
  if (cached) return { ...cached, source: "cache(stale)" };

  throw new Error(
    "DeepAI transport token not found. Start DeepAI Code (the token is read from its `pi` process), " +
      "or pass --token <token> / set DEEPAI_TRANSPORT_TOKEN.",
  );
}

export function storeToken(token) {
  writeCache(token, null);
}
