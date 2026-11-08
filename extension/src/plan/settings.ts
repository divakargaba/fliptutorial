import { z } from 'zod';
import { SETTINGS_KEY, ACTIVE_ACCOUNT_KEY, DEFAULT_SETTINGS, DEFAULT_ACCOUNT } from '../v2/types';

// Stable, local-only keys shared with the popup. Reads fail closed for malformed
// settings rather than accidentally enabling interruptions after corruption.
export { SETTINGS_KEY };
export const ACCOUNT_KEY = ACTIVE_ACCOUNT_KEY;
export const SettingsSchema = z.object({
  frequency: z.enum(['few', 'normal', 'many']), autoPause: z.boolean(),
  disabledVideos: z.array(z.string().regex(/^[A-Za-z0-9_-]{11}$/)).max(10000),
}).strict();
export type LearnerSettings = z.infer<typeof SettingsSchema>;
export const defaultSettings: LearnerSettings = DEFAULT_SETTINGS;
export function readSettings(value: unknown): LearnerSettings {
  if (value === undefined) return { ...defaultSettings, disabledVideos: [] };
  const parsed = SettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...defaultSettings, autoPause: false, disabledVideos: [] };
}
export function readAccount(value: unknown): string {
  return typeof value === 'string' && /^test-[a-z0-9-]{1,80}$/.test(value) ? value : DEFAULT_ACCOUNT;
}
