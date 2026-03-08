import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const outdir = path.join(projectRoot, "dist", "ui");

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, "src", "ui", "main.tsx")],
  outfile: path.join(outdir, "app.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: {
    ".css": "css"
  }
});

await cp(path.join(projectRoot, "src", "ui", "index.html"), path.join(outdir, "index.html"));
