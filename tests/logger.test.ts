import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configureLogger,
  flushLogs,
  log,
  logger,
  readRecentLogs,
  type LogEntry,
} from "@howa/utils/logger.js";

let stateRoot: string;

describe("file-persistent logger (C1)", () => {
  beforeAll(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "howa-logger-"));
    configureLogger(stateRoot);
  });

  afterAll(async () => {
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("writes JSON lines to server.log and reads them back", async () => {
    logger.info("test", "hello world");
    logger.warn("test", "careful now");
    await flushLogs();

    const file = path.join(stateRoot, "server.log");
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Every line must be valid JSON with the required shape.
    for (const line of lines) {
      const entry = JSON.parse(line) as LogEntry;
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("level");
      expect(entry).toHaveProperty("component");
      expect(entry).toHaveProperty("message");
      // timestamp is a valid ISO date
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    }

    const parsed = lines.map((l) => JSON.parse(l) as LogEntry);
    expect(parsed.some((e) => e.message === "hello world" && e.level === "info")).toBe(true);
    expect(parsed.some((e) => e.message === "careful now" && e.level === "warn")).toBe(true);
  });

  it("redacts secrets in log messages", async () => {
    log("error", "test", "leaked key sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX happened");
    await flushLogs();

    const file = path.join(stateRoot, "server.log");
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(raw).toContain("[REDACTED:anthropic_api_key]");
  });

  it("readRecentLogs returns the last N entries oldest-first", async () => {
    for (let i = 0; i < 10; i++) logger.info("seq", `entry-${i}`);
    await flushLogs();

    const recent = await readRecentLogs(3);
    expect(recent).toHaveLength(3);
    expect(recent[recent.length - 1].message).toBe("entry-9");
  });
});
