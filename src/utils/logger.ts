import { promises as fs } from "node:fs";
import path from "node:path";
import { redact } from "../velum/redaction.js";
import { resolveStateRoot } from "../storage/index.js";

/**
 * File-persistent structured logger.
 *
 * The server runs as a background process with no attached terminal, so
 * `console.log`/`console.error` go nowhere an operator can read after the
 * fact. This logger appends JSON lines to `<stateRoot>/server.log` so there
 * is a durable record of startup, shutdown, caught errors, and adapter
 * health-check failures — while still echoing to the console for dev use.
 *
 * Each line is a self-contained JSON object:
 *   { timestamp, level, component, message }
 *
 * Secrets are redacted from the message before it is written or printed.
 * The file rotates to `server.log.1` once it crosses 10MB.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** ISO-8601 timestamp. */
  timestamp: string;
  level: LogLevel;
  /** Subsystem that emitted the line (e.g. "server", "runner"). */
  component: string;
  message: string;
}

/** Rotate the log once it grows past this many bytes. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const LOG_FILENAME = "server.log";

let logFilePath: string | null = null;
/**
 * All file writes are funnelled through this promise chain so concurrent
 * `log()` calls never interleave a partial line or race the rotation rename.
 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * Point the logger at a specific state root. Called once at server startup.
 * If never called, the log file is resolved lazily from HOWA_STATE_ROOT (or
 * the default state root) on first write.
 */
export function configureLogger(stateRoot: string): void {
  logFilePath = path.join(stateRoot, LOG_FILENAME);
}

function resolveLogFile(): string {
  if (!logFilePath) {
    logFilePath = path.join(resolveStateRoot(process.env.HOWA_STATE_ROOT), LOG_FILENAME);
  }
  return logFilePath;
}

async function appendLine(line: string): Promise<void> {
  const file = resolveLogFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Rotate before appending if the current file is already at the cap.
  try {
    const st = await fs.stat(file);
    if (st.size >= MAX_LOG_BYTES) {
      await fs.rename(file, `${file}.1`);
    }
  } catch {
    // File does not exist yet — nothing to rotate.
  }
  await fs.appendFile(file, line + "\n");
}

/**
 * Emit one structured log line. Echoes to the console (stderr for `error`,
 * stdout otherwise) and durably appends to the rotating log file. File I/O
 * is best-effort: a write failure never throws into the caller.
 */
export function log(level: LogLevel, component: string, message: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message: redact(String(message)).redacted,
  };
  const line = JSON.stringify(entry);
  // Keep console output for terminal/dev use.
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  writeChain = writeChain.then(() => appendLine(line)).catch(() => {
    // Never let a logging failure crash the caller.
  });
}

export const logger = {
  debug: (component: string, message: string) => log("debug", component, message),
  info: (component: string, message: string) => log("info", component, message),
  warn: (component: string, message: string) => log("warn", component, message),
  error: (component: string, message: string) => log("error", component, message),
};

/**
 * Wait for all queued file writes to flush. Primarily for tests and clean
 * shutdown — production callers fire-and-forget.
 */
export async function flushLogs(): Promise<void> {
  await writeChain;
}

/**
 * Read the most recent `limit` log lines back as parsed entries (oldest
 * first). Unparseable lines are skipped. Returns [] when the file is absent.
 */
export async function readRecentLogs(limit = 100): Promise<LogEntry[]> {
  await flushLogs();
  const file = resolveLogFile();
  const txt = await fs.readFile(file, "utf8").catch(() => "");
  if (!txt) return [];
  const lines = txt.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-limit);
  const out: LogEntry[] = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
