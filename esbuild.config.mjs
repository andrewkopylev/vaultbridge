import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const banner = `/*
Vault Bridge SFTP — Obsidian plugin
Generated bundle. Do not edit by hand; edit src/ instead.
*/
`;

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    // ssh2 optional native deps — fall back to pure JS at runtime
    "cpu-features",
    "./crypto/build/Release/sshcrypto.node",
  ],
  format: "cjs",
  target: "es2020",
  platform: "node",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
