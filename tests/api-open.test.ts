import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "@colosseum/api/server.js";
import { CANONICAL_CAPABILITIES } from "@colosseum/capabilities.js";

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

describe("open local API", () => {
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

  it("serves health without any authorization header", async () => {
    const res = await request("/api/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, version: "0.1.0" });
  });

  it("serves API routes without any authorization header", async () => {
    const res = await request("/api/agents");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty("agents");
  });

  it("/api/agents returns a complete evidence-backed capability matrix", async () => {
    const res = await request("/api/agents");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      agents: Array<{
        capabilityMatrix: Record<string, { state: string; evidence: { source: string } }>;
        capabilityList: Array<{ key: string; state: string }>;
      }>;
    };
    for (const agent of body.agents) {
      expect(Object.keys(agent.capabilityMatrix).sort()).toEqual(
        [...CANONICAL_CAPABILITIES].sort(),
      );
      expect(agent.capabilityList.map((capability) => capability.key)).toEqual(
        CANONICAL_CAPABILITIES,
      );
      for (const key of CANONICAL_CAPABILITIES) {
        const capability = agent.capabilityMatrix[key];
        expect(capability).toBeDefined();
        if (capability.evidence.source === "static") {
          expect(capability.state).not.toBe("PROVEN");
        }
      }
    }
  });
});
