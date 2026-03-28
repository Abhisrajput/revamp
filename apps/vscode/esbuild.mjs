import * as esbuild from "esbuild";
import process from "process";

const args = process.argv.slice(2);
const isWatch = args.includes("--watch");

const config = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  platform: "node",
  target: "node18",
  sourcemap: args.includes("--sourcemap") || isWatch,
  minify: !isWatch,
  define: {
    global: "globalThis",
  },
};

async function build() {
  const ctx = await esbuild.context(config);

  if (isWatch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
