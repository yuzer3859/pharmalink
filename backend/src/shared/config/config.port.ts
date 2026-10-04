/**
 * IConfigPort — the stable contract feature modules depend on for tunable parameters.
 *
 * Phase 0 provides an env-backed implementation (AppConfigService). Module 16 (Admin)
 * will later provide a DB-backed implementation (system_configs + feature_flags) that
 * can override defaults at runtime, without any feature module changing its code.
 */
export const CONFIG_PORT = Symbol('CONFIG_PORT');

export interface IConfigPort {
  get<T = string>(key: string): T | undefined;
  getOrThrow<T = string>(key: string): T;
  isFeatureEnabled(flag: string): boolean;
}
