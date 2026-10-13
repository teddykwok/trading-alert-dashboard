import { resolve } from "node:path";

import { envFilePathFor } from "../operator/dual-account-topology";
import type { NativeAccountSlot } from "./native-account-a-canary";

/**
 * Which account THIS process is, for the Native canary.
 *
 * An execution process carries no A/B label of its own: it binds whichever
 * account its environment file names. The launcher starts Account A's roles
 * with DOTENV_CONFIG_PATH pointing at exactly `<runtime env dir>/account-a.env`
 * and Account B's at `account-b.env` (dual-account-topology.ts), so that path
 * is the process's account identity.
 *
 * Pure: a function of the environment it is given, with no file read. Anything
 * that is not exactly one of the launcher's files is UNKNOWN. There is no
 * default account, no fallback, and no way to be "both".
 */
export function nativeAccountSlotOf(env: NodeJS.ProcessEnv): NativeAccountSlot {
  const configured = env.DOTENV_CONFIG_PATH?.trim();
  if (!configured || !env.LOCALAPPDATA?.trim()) return "UNKNOWN";
  // Windows paths compare case-insensitively, exactly as runtime-env.ts does.
  const same = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
  const isA = same(configured, envFilePathFor("account-a-worker", env));
  const isB = same(configured, envFilePathFor("account-b-worker", env));
  if (isA && !isB) return "ACCOUNT_A";
  if (isB && !isA) return "ACCOUNT_B";
  if (!isA && !isB && same(configured, envFilePathFor("generic-backend", env))) return "GENERIC";
  return "UNKNOWN";
}
