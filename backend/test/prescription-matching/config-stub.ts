import { IConfigPort } from '../../src/shared/config/config.port';

/** Minimal `IConfigPort` stub — every command reads config keys optionally (`?? default`), so
 * "always unset" exercises each command's own documented default (§0.1/§20 Q2). */
export const CONFIG_PORT_STUB: IConfigPort = {
  get: () => undefined,
  getOrThrow: () => {
    throw new Error('CONFIG_PORT_STUB.getOrThrow is not implemented — no command under test calls it.');
  },
  isFeatureEnabled: () => false,
};
