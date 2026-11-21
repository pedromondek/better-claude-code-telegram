import { userInfo } from "node:os";
import { join } from "node:path";

const realHome = userInfo().homedir;

export function miseEnv(trustedPath) {
  return {
    MISE_DATA_DIR:
      process.env.MISE_DATA_DIR ?? join(realHome, ".local", "share", "mise"),
    MISE_CACHE_DIR:
      process.env.MISE_CACHE_DIR ?? join(realHome, ".cache", "mise"),
    MISE_TRUSTED_CONFIG_PATHS: trustedPath,
  };
}
