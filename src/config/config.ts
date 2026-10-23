import { z } from 'zod';
import { NotInitializedError } from './errors.js';
import { readJsonFile, writeJsonFile } from './fs.js';
import { configFile } from './paths.js';
import { ProfileNameSchema } from './profile.js';

/** `openai` is any OpenAI-compatible API at a base URL the user enters (OpenRouter, Ollama…). */
export const ProviderSchema = z.enum(['claude', 'gemini', 'openai']);
export type Provider = z.infer<typeof ProviderSchema>;

/** `config.json`: how Jobhunter runs and authenticates. Never holds user/profile data. */
export const ConfigSchema = z
  .object({
    version: z.literal(1),
    provider: ProviderSchema,
    model: z.string().min(1),
    /** Asked in `init`; there is deliberately no environment variable fallback. */
    apiKey: z.string().min(1),
    /** Where the `openai` provider sends requests. The other providers have a fixed one. */
    baseURL: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * Whether a model on a local server may think before answering; asked in `init`, for local
     * servers only. Unset: off on a local server, the provider's own default everywhere else.
     */
    thinking: z.boolean().optional(),
    activeProfile: ProfileNameSchema.default('default'),
  })
  .refine((config) => config.provider !== 'openai' || config.baseURL !== undefined, {
    message: 'The openai provider needs a baseURL',
    path: ['baseURL'],
  });
export type Config = z.infer<typeof ConfigSchema>;

export async function readConfig(): Promise<Config | undefined> {
  return readJsonFile(configFile(), ConfigSchema);
}

export async function loadConfig(): Promise<Config> {
  const config = await readConfig();
  if (!config) throw new NotInitializedError();
  return config;
}

export async function saveConfig(config: Config): Promise<void> {
  await writeJsonFile(configFile(), ConfigSchema.parse(config), { secret: true });
}
