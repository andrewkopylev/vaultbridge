/** Join a remote root with a vault-relative path, normalizing slashes. */
export function remotePathOf(remoteRoot: string, vaultRelative: string): string {
  const root = remoteRoot.replace(/\/+$/, "");
  const rel = vaultRelative.replace(/^\/+/, "");
  return `${root}/${rel}`;
}

/** Get parent directory portion (no trailing slash). Returns "" if no slash. */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.substring(0, i);
}
