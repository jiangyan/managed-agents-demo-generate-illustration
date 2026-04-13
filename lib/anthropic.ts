import Anthropic from "@anthropic-ai/sdk";

export const AGENT_ID = "agent_011Ca1UqQ362iEbpTghs4nqF";

export const anthropic = new Anthropic();

let cachedEnvId: string | null = null;
let envPromise: Promise<string> | null = null;

export async function getEnvironmentId(): Promise<string> {
  if (cachedEnvId) return cachedEnvId;
  if (envPromise) return envPromise;

  envPromise = (async () => {
    const env = await anthropic.beta.environments.create({
      name: `illustration-env-${Date.now()}`,
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
      },
    });
    cachedEnvId = env.id;
    return env.id;
  })();

  return envPromise;
}
