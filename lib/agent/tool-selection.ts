import {
  AGENT_TOOL_DEFINITIONS,
  type AgentToolDefinition,
  type AgentToolName,
} from "./tools";

const starterIntents: Array<{ pattern: RegExp; tools: AgentToolName[] }> = [
  {
    pattern: /^(?:when (?:would|will|could) smoke reach (?:here|this (?:asset|site))|how soon could smoke reach (?:here|this (?:asset|site)))$/,
    tools: ["get_smoke_arrival"],
  },
  {
    pattern: /^which of my (?:sites|assets|places) (?:is|are) in trouble$/,
    tools: ["triage_assets"],
  },
  {
    pattern: /^what (?:evidence|data) is missing(?: for (?:this|the) (?:asset|site))?$/,
    tools: ["inspect_asset"],
  },
];

function normalizedStarterPrompt(prompt: string) {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

/**
 * Reduce the native tool schema only for tightly matched one-click intent
 * families. Ambiguous free-form prompts retain the complete allowlist.
 */
export function selectAgentTools(prompt: string): AgentToolDefinition[] {
  const normalized = normalizedStarterPrompt(prompt);
  const intent = starterIntents.find(({ pattern }) => pattern.test(normalized));
  if (!intent) return AGENT_TOOL_DEFINITIONS;
  const names = new Set(intent.tools);
  return AGENT_TOOL_DEFINITIONS.filter((tool) => names.has(tool.function.name));
}
