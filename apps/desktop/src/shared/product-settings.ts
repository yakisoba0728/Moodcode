export interface DesktopAgentProfile {
  id: string; description: string; instructions: string; tools?: string[]; modelId?: string; turnAllowance?: number;
}
export interface DesktopPlugin { name: string; version: string; enabled: boolean }
export interface ProductSettings {
  schemaVersion: 1; web: boolean; globalSkills: boolean; compatibilitySkills: boolean;
  searchKeyEnv?: string; profiles: DesktopAgentProfile[]; plugins: DesktopPlugin[];
}
export interface ProductSettingsView { settings: ProductSettings; revision: string; searchKeyConfigured: boolean; installed: { name: string; version: string }[]; error?: string }
export const DEFAULT_PRODUCT_SETTINGS: ProductSettings = { schemaVersion: 1, web: false, globalSkills: false, compatibilitySkills: false, profiles: [], plugins: [] };
const encoder = new TextEncoder();
function invalid(): never { throw Object.assign(new Error('확장 설정의 값이나 크기가 올바르지 않아요.'), { code: 'PRODUCT_SETTINGS_INVALID' }); }
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result.push(descriptor.value);
  }
  return result;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || !empty && !value.trim() || encoder.encode(value).length > max || value.includes('\0')) invalid();
  return value;
}
export function validatePlugin(value: unknown): DesktopPlugin {
  const item = record(value, ['name', 'version', 'enabled']);
  const name = text(item.name, 214), version = text(item.version, 64);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) || name.includes('..')
    || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) || typeof item.enabled !== 'boolean') invalid();
  return { name, version, enabled: item.enabled };
}
export function validateProductSettings(value: unknown): ProductSettings {
  const input = record(value, ['schemaVersion', 'web', 'globalSkills', 'compatibilitySkills', 'searchKeyEnv', 'profiles', 'plugins']);
  if (input.schemaVersion !== 1 || ['web', 'globalSkills', 'compatibilitySkills'].some(key => typeof input[key] !== 'boolean')
    ) invalid();
  const profiles = array(input.profiles, 8).map(raw => {
    const item = record(raw, ['id', 'description', 'instructions', 'tools', 'modelId', 'turnAllowance']);
    const profile: DesktopAgentProfile = { id: text(item.id, 128), description: text(item.description, 4096, true), instructions: text(item.instructions, 32_768, true) };
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(profile.id)) invalid();
    if (item.tools !== undefined) {
      const tools = array(item.tools, 256);
      if (tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) || new Set(tools).size !== tools.length) invalid();
      profile.tools = tools as string[];
    }
    if (item.modelId !== undefined) {
      profile.modelId = text(item.modelId, 256);
      if (profile.modelId.trim() !== profile.modelId || /[\u0000-\u001f\u007f]/u.test(profile.modelId)) invalid();
    }
    if (item.turnAllowance !== undefined) {
      if (!Number.isSafeInteger(item.turnAllowance) || typeof item.turnAllowance !== 'number' || item.turnAllowance < 1 || item.turnAllowance > 10_000) invalid();
      profile.turnAllowance = item.turnAllowance;
    }
    return profile;
  });
  const plugins = array(input.plugins, 8).map(validatePlugin);
  if (new Set(profiles.map(item => item.id)).size !== profiles.length || new Set(plugins.map(item => item.name)).size !== plugins.length) invalid();
  const result: ProductSettings = { schemaVersion: 1, web: input.web as boolean, globalSkills: input.globalSkills as boolean, compatibilitySkills: input.compatibilitySkills as boolean, profiles, plugins };
  if (input.searchKeyEnv !== undefined) {
    const name = text(input.searchKeyEnv, 128);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name)) invalid();
    result.searchKeyEnv = name;
  }
  if (encoder.encode(JSON.stringify(result)).length > 524_288) invalid();
  return result;
}
export function validateProductSave(value: unknown): { revision: string; settings: ProductSettings } {
  const input = record(value, ['revision', 'settings']);
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(input.revision)) invalid();
  return { revision: input.revision, settings: validateProductSettings(input.settings) };
}
