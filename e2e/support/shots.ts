import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QUAL1: the one folder E2E screenshots and measurements go under. SHOTS_ROOT when set; else the builders' own
 * files folder when this machine has it (where the shots have always gone); else a folder in the system temp
 * directory. A CI runner has no /home/user, so a hard coded path there failed with EACCES and stopped the run.
 * SHOTS_DIR and the other per spec variables still pick an exact folder.
 */
const BUILDERS_FILES = "/home/user/tab/files";
export const SHOTS_ROOT = process.env.SHOTS_ROOT || (existsSync(BUILDERS_FILES) ? BUILDERS_FILES : join(tmpdir(), "multies-e2e-shots"));
