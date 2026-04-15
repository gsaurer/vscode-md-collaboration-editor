// @ts-check
const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  bundle: true,
  platform: "node",
  format: "cjs",
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  bundle: true,
  platform: "browser",
  format: "iife",
  entryPoints: ["webview-src/index.ts"],
  outfile: "dist/webview.js",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      isWatch ? "development" : "production"
    ),
  },
};

async function build() {
  if (isWatch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log("Watching for changes…");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
    ]);
    console.log("Build complete.");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
