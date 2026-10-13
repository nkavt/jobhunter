import { z } from 'zod';
import { NotInitializedError } from './errors.js';
import { readJsonFile, writeJsonFile } from './fs.js';
import { configFile } from './paths.js';
import { ProfileNameSchema } from './profile.js';

export const ProviderSchema = z.enum(['claude', 'gemini']);
export type Provider = z.infer<typeof ProviderSchema>;

/** `config.json`: how Jobhunter runs and authenticates. Never holds user/profile data. */
export const ConfigSchema = z.object({
  version: z.literal(1),
  provider: ProviderSchema,
  model: z.string().min(1),
  /** Asked in `init`; there is deliberately no environment variable fallback. */
  apiKey: z.string().min(1),
  activeProfile: ProfileNameSchema.default('default'),
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
