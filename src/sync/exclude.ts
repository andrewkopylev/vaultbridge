import type { App } from "obsidian";
import { pluginPaths } from "../state/paths";
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
  private configDir: string;
  private stateDirPrefix: string;
  private workspacePaths: string[];

  constructor(app: App, settings: SftpSyncSettings) {
    const paths = pluginPaths(app.vault.configDir);
    this.configDir = paths.configDir;
    this.stateDirPrefix = paths.stateDirPrefix;
    this.workspacePaths = [
      `${this.configDir}/workspace.json`,
      `${this.configDir}/workspace-mobile.json`,
    ];
    this.patterns = settings.excludePatterns.map(globToRegex);
    this.excludeObsidianFolder = !settings.syncEverything;
    this.excludeWorkspaceJson = !settings.syncWorkspaceJson;
  }

  /** Returns true if the given vault-relative path should NOT be synced. */
  isExcluded(path: string): boolean {
    // 1. Hard-coded: our own state directory.
    if (path === this.stateDirPrefix.slice(0, -1) || path.startsWith(this.stateDirPrefix)) {
      return true;
    }
    // 2. Obsidian config folder excluded entirely if user opted out.
    if (this.excludeObsidianFolder && (path === this.configDir || path.startsWith(this.configDir + "/"))) {
      return true;
    }
    // 3. workspace.json — separate opt-in because user-asked-for full sync still excludes these.
    if (this.excludeWorkspaceJson) {
      if (this.workspacePaths.includes(path)) return true;
    }
    // 4. User-defined soft excludes.
    for (const re of this.patterns) {
      if (re.test(path)) return true;
    }
    return false;
  }
}
