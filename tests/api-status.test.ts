import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "@howa/api/server.js";

let server: http.Server;
let baseUrl: string;

async function request(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(path, baseUrl), (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

describe("/api/status endpoint", () => {
  beforeAll(async () => {
    const app = await buildApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  });

  it("returns 200 and expected shape", async () => {
    const res = await request("/api/status");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);

    expect(data).toHaveProperty("uptime");
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThanOrEqual(0);

    expect(data).toHaveProperty("version");
    expect(typeof data.version).toBe("string");
    expect(data.version).toBe("0.1.0");

    expect(data).toHaveProperty("memory");
    expect(data.memory).toHaveProperty("rss");
    expect(data.memory).toHaveProperty("heapTotal");
    expect(data.memory).toHaveProperty("heapUsed");
    expect(typeof data.memory.rss).toBe("number");
    expect(typeof data.memory.heapTotal).toBe("number");
    expect(typeof data.memory.heapUsed).toBe("number");

    expect(data).toHaveProperty("routes");
    expect(typeof data.routes).toBe("number");
    expect(data.routes).toBeGreaterThan(0);
  });
});
