import React, { useEffect, useState } from "react";
import { api, type AgentSummary, type CapabilityStatus } from "../api.js";

const CAPABILITY_ORDER = [
  "streaming",
  "toolUse",
  "fileEditing",
  "shellExecution",
  "modelSelection",
  "reportsCost",
  "reportsTokens",
];

const CAPABILITY_LABELS: Record<string, string> = {
  streaming: "Streaming",
  toolUse: "Tool Use",
  fileEditing: "File Editing",
  shellExecution: "Shell Execution",
  modelSelection: "Model Selection",
  reportsCost: "Reports Cost",
  reportsTokens: "Reports Tokens",
};

function capabilityRows(agent: AgentSummary): CapabilityStatus[] {
  if (agent.capabilityList?.length) return agent.capabilityList;
  return CAPABILITY_ORDER.map((key) => {
    const claimed = agent.capabilities[key];
    return {
      key,
      label: CAPABILITY_LABELS[key] ?? key,
      state: claimed ? "SUPPORTED_NOT_PROVEN" : "UNSUPPORTED",
      claimed: typeof claimed === "boolean" ? claimed : null,
      evidence: {
        source: "static",
        reason: claimed
          ? "Adapter declares support, but no runtime proof has been recorded yet."
          : "Adapter declares this capability unsupported.",
      },
    };
  });
}

function stateClass(state: CapabilityStatus["state"]): string {
  switch (state) {
    case "PROVEN":
      return "proven";
    case "SUPPORTED_NOT_PROVEN":
      return "supported";
    case "BLOCKED_BY_CONFIG":
      return "blocked";
    case "UNSUPPORTED":
      return "unsupported";
    case "NOT_TESTED":
    case "UNKNOWN":
    default:
      return "unknown";
  }
}

function stateText(state: CapabilityStatus["state"]): string {
  return state.replaceAll("_", " ");
}

export function Agents() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  useEffect(() => {
    api.agents().then(setAgents);
  }, []);
  return (
    <div className="page">
      <h1 className="page-title">Agents</h1>
      <div className="page-sub">Combatants registered to the arena.</div>
      <div className="cols">
        {agents.map((a) => (
          <div className="marble" key={a.id}>
            <div className="row between">
              <h2 style={{ margin: 0 }}>{a.name}</h2>
              <span className="pill pill-marble">{a.id}</span>
            </div>
            <p style={{ color: "var(--ink-soft)" }}>{a.description}</p>
            <div className="capability-matrix" aria-label={`${a.name} capability matrix`}>
              {capabilityRows(a).map((capability) => (
                <div className="capability-row" key={capability.key}>
                  <span className="capability-name">{capability.label}</span>
                  <span
                    className={`capability-state ${stateClass(capability.state)}`}
                    title={capability.evidence.reason}
                  >
                    {stateText(capability.state)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
