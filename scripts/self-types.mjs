// Each built module names its own types (Deno reads them when the package is used as files, without npm).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
for (const f of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const js = readFileSync(`dist/${f}`, "utf8");
  if (!js.startsWith("// @ts-self-types")) writeFileSync(`dist/${f}`, `// @ts-self-types="./${f.replace(/\.js$/, ".d.ts")}"\n${js}`);
}
