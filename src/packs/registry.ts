import type { TestPack } from "./types.js";
import { truthfulnessPack } from "./truthfulness/index.js";
import { repoEditingPack } from "./repo-editing/index.js";
import { safetyPack } from "./safety/index.js";
import { staminaPack } from "./stamina/index.js";
import { localModelPack } from "./local-model/index.js";
import { toolCallingPack } from "./tool-calling/index.js";
import { contextStaminaPack } from "./context-stamina/index.js";

const packs: Record<string, TestPack> = {
  truthfulness: truthfulnessPack,
  "repo-editing": repoEditingPack,
  safety: safetyPack,
  stamina: staminaPack,
  "local-model": localModelPack,
  "tool-calling": toolCallingPack,
  "context-stamina": contextStaminaPack,
};

export function listPacks(): TestPack[] {
  return Object.values(packs);
}

export function getPack(id: string): TestPack {
  const p = packs[id];
  if (!p) {
    throw new Error(
      `Unknown pack "${id}". Available: ${Object.keys(packs).join(", ")}`,
    );
  }
  return p;
}

export function packIds(): string[] {
  return Object.keys(packs);
}
