import { STATE_DIR_PREFIX } from "../state/paths";
import type { SftpSyncSettings } from "../settings";

/**
 * Convert a gitignore-style glob to a RegExp anchored to the full path.
 * Supported: `**` (any path including /), `*` (any non-/), `?` (one non-/), literal segments.
 */
function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (glob[i] === "/") i++; // consume the slash after **
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if ("\\^$.|+(){}[]".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

export class ExcludeMatcher {
  private patterns: RegExp[];
  private excludeObsidianFolder: boolean;
  private excludeWorkspaceJson: boolean;

  constructor(settings: SftpSyncSettings) {
    this.patterns = settings.excludePatterns.map(globToRegex);
    this.excludeObsidianFolder = !settings.syncEverything;
    this.excludeWorkspaceJson = !settings.syncWorkspaceJson;
  }

  /** Returns true if the given vault-relative path should NOT be synced. */
  isExcluded(path: string): boolean {
    // 1. Hard-coded: our own state directory.
    if (path === STATE_DIR_PREFIX.slice(0, -1) || path.startsWith(STATE_DIR_PREFIX)) {
      return true;
    }
    // 2. .obsidian folder excluded entirely if user opted out.
    if (this.excludeObsidianFolder && (path === ".obsidian" || path.startsWith(".obsidian/"))) {
      return true;
    }
    // 3. workspace.json — separate opt-in because user-asked-for full sync still excludes these.
    if (this.excludeWorkspaceJson) {
      if (path === ".obsidian/workspace.json" || path === ".obsidian/workspace-mobile.json") {
        return true;
      }
    }
    // 4. User-defined soft excludes.
    for (const re of this.patterns) {
      if (re.test(path)) return true;
    }
    return false;
  }
}
