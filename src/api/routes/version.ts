import { Router } from "express";
import { HOWA_VERSION, getGitCommit } from "../../version.js";

export function versionRouter(): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    res.json({
      version: HOWA_VERSION,
      gitCommit: getGitCommit(),
      nodeVersion: process.version,
    });
  });
  return r;
}
