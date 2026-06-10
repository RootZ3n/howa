import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentsRouter } from "./routes/agents.js";
import { packsRouter } from "./routes/packs.js";
import { trialsRouter } from "./routes/trials.js";
import { receiptsRouter } from "./routes/receipts.js";
import { adminRouter } from "./routes/admin.js";
import { resolveStateRoot, TrialStore } from "../storage/index.js";
import { configureLogger, logger } from "../utils/logger.js";

// HOWA_STATE_ROOT is the canonical env var (matches systemd unit + docs).
// Use resolveStateRoot so an empty/blank value (systemd + start.sh export
// HOWA_STATE_ROOT="") falls back to the absolute default instead of "".
const stateRoot = resolveStateRoot(process.env.HOWA_STATE_ROOT);
const port = Number(process.env.HOWA_PORT ?? 18799);
const host = process.env.HOWA_HOST ?? "127.0.0.1";

export async function buildApp(): Promise<express.Express> {
  configureLogger(stateRoot);
  await new TrialStore(stateRoot).ensureLayout();
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, stateRoot, version: "0.1.0" }),
  );

  app.use("/api/agents", agentsRouter(stateRoot));
  app.use("/api/packs", packsRouter());
  app.use("/api/trials", trialsRouter(stateRoot));
  app.use("/api/receipts", receiptsRouter(stateRoot));
  app.use("/api/admin", adminRouter(stateRoot));

  // Serve built UI when present.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const uiDir = path.resolve(here, "../ui");
    app.use(express.static(uiDir));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(uiDir, "index.html")));
  } catch {
    // dev mode — Vite serves the UI.
  }

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildApp()
    .then((app) => {
      app.listen(port, host, () => {
        logger.info("server", `Howa API listening on http://${host}:${port}`);
        logger.info("server", `State root: ${stateRoot}`);
        // eslint-disable-next-line no-console
        console.log(`Howa API listening on http://${host}:${port}`);
        console.log(`UI:        http://${host}:${port}/`);
        console.log(`Health:    http://${host}:${port}/api/health`);
        console.log(`State:     ${stateRoot}`);
      });
    })
    .catch((err) => {
      logger.error("server", `Fatal: server failed to start — ${(err as Error).message}`);
      process.exitCode = 1;
    });
}
