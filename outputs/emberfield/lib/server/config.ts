import { z } from "zod";

const OLLAMA_PROBE_TIMEOUT_MS = 2_000;
const OLLAMA_PROBE_MAX_BYTES = 1_000_000;
export const REQUIRED_OLLAMA_MODEL = "gemma4:12b";

const runtimeConfigSchema = z.object({
  firmsMapKey: z.string().default(""),
  airnowApiKey: z.string().default(""),
  ollamaBaseUrl: z.url().default("http://127.0.0.1:11434"),
});

type RuntimeEnvironment = Record<string, string | undefined>;

export type SourceStatus = "ready" | "missing-key" | "offline" | "error";

export interface RuntimeConfig {
  firms: { mapKey: string };
  airnow: { apiKey: string };
  ollama: { baseUrl: string; model: string };
}

export interface IntegrationHealth {
  configured: boolean;
  status: SourceStatus;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  integrations: {
    firms: IntegrationHealth;
    airnow: IntegrationHealth;
    ollama: IntegrationHealth;
  };
}

function getProcessEnvironment(): RuntimeEnvironment {
  return typeof process === "undefined" ? {} : process.env;
}

function getValue(
  workerEnvironment: RuntimeEnvironment,
  name: keyof RuntimeEnvironment,
): string | undefined {
  return Object.hasOwn(workerEnvironment, name)
    ? workerEnvironment[name]
    : getProcessEnvironment()[name];
}

export function getRuntimeConfig(
  workerEnvironment: RuntimeEnvironment = {},
): RuntimeConfig {
  const values = runtimeConfigSchema.parse({
    firmsMapKey: getValue(workerEnvironment, "FIRMS_MAP_KEY"),
    airnowApiKey: getValue(workerEnvironment, "AIRNOW_API_KEY"),
    ollamaBaseUrl: getValue(workerEnvironment, "OLLAMA_BASE_URL"),
  });

  return {
    firms: { mapKey: values.firmsMapKey },
    airnow: { apiKey: values.airnowApiKey },
    ollama: {
      baseUrl: values.ollamaBaseUrl.replace(/\/+$/, ""),
      model: REQUIRED_OLLAMA_MODEL,
    },
  };
}

function configuredSource(configured: boolean): IntegrationHealth {
  return {
    configured,
    status: configured ? "ready" : "missing-key",
  };
}

async function probeOllama(
  baseUrl: string,
  requiredModel: string,
  fetchImplementation: typeof fetch,
): Promise<IntegrationHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);

  try {
    const response = await fetchImplementation(`${baseUrl}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) return { configured: true, status: "error" };
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > OLLAMA_PROBE_MAX_BYTES
    ) {
      return { configured: true, status: "error" };
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > OLLAMA_PROBE_MAX_BYTES) {
      return { configured: true, status: "error" };
    }
    const payload = JSON.parse(text) as { models?: unknown };
    const models = Array.isArray(payload.models) ? payload.models : [];
    const installed = models.some((value) => {
      if (!value || typeof value !== "object") return false;
      const model = value as { name?: unknown; model?: unknown };
      return model.name === requiredModel || model.model === requiredModel;
    });
    return {
      configured: installed,
      status: installed ? "ready" : "error",
    };
  } catch (error) {
    const isOffline =
      error instanceof TypeError ||
      (error instanceof DOMException && error.name === "AbortError");

    return { configured: true, status: isOffline ? "offline" : "error" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildHealth(
  workerEnvironment: RuntimeEnvironment = {},
  fetchImplementation: typeof fetch = fetch,
): Promise<HealthPayload> {
  const config = getRuntimeConfig(workerEnvironment);
  const [firms, airnow, ollama] = await Promise.all([
    configuredSource(Boolean(config.firms.mapKey)),
    configuredSource(Boolean(config.airnow.apiKey)),
    probeOllama(config.ollama.baseUrl, config.ollama.model, fetchImplementation),
  ]);

  const integrations = { firms, airnow, ollama };
  const status = Object.values(integrations).every(
    (integration) => integration.status === "ready" || integration.status === "missing-key",
  )
    ? "ok"
    : "degraded";

  return { status, integrations };
}
