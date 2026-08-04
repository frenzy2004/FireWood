import { describe, expect, it } from "vitest";

import { selectAgentTools } from "../lib/agent/tool-selection";
import { AGENT_TOOL_DEFINITIONS } from "../lib/agent/tools";

const toolNames = (tools: typeof AGENT_TOOL_DEFINITIONS) => tools.map((tool) => tool.function.name);

describe("Gemma intent-scoped native tools", () => {
  it("offers only smoke arrival for the arrival starter", () => {
    expect(toolNames(selectAgentTools("When would smoke reach here?"))).toEqual([
      "get_smoke_arrival",
    ]);
    expect(toolNames(selectAgentTools("  How soon could smoke reach this site?  "))).toEqual([
      "get_smoke_arrival",
    ]);
  });

  it("offers one portfolio tool for the triage starter", () => {
    expect(toolNames(selectAgentTools("Which of my sites is in trouble?"))).toEqual([
      "triage_assets",
    ]);
  });

  it("offers one snapshot tool for the missing-evidence starter", () => {
    expect(toolNames(selectAgentTools("What evidence is missing?"))).toEqual([
      "inspect_asset",
    ]);
    expect(toolNames(selectAgentTools("What data is missing for this asset?"))).toEqual([
      "inspect_asset",
    ]);
  });

  it("keeps the full allowlist for ambiguous free-form prompts", () => {
    expect(selectAgentTools("Brief me on verified activity near the orchard."))
      .toEqual(AGENT_TOOL_DEFINITIONS);
    expect(selectAgentTools("Could smoke and air quality affect another site?"))
      .toEqual(AGENT_TOOL_DEFINITIONS);
  });
});
