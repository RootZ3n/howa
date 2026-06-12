import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "@howa/api/server.js";

let server: http.Server;
let baseUrl: string;

/** POST to a path with a raw body and optional Content-Type. */
async function post(
  path: string,
  body: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("server error handler", () => {
  beforeAll(async () => {
    const app = await buildApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("logs the error via console.error and returns 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Malformed JSON triggers express.json() parse failure → next(err) →
    // the global error handler.
    const res = await post("/api/trials", "not valid json {{{");

    expect(res.status).toBe(500);
    const data = JSON.parse(res.body);
    expect(data).toMatchObject({ error: "Internal server error" });

    // console.error must have been called at least once with the error.
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
