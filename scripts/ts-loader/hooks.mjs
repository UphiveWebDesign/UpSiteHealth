// Node module resolve hook for running the repository's TypeScript directly
// (with --experimental-transform-types): maps the `@/` alias to src/ and
// adds the extension to extensionless imports in repository files, as the
// bundler (tsconfig "moduleResolution": "bundler") does. node_modules are
// resolved by Node unchanged. Loaded by register.mjs.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const isFile = (p) => existsSync(p) && statSync(p).isFile();

export async function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) base = SRC + specifier.slice(2);
  else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:") &&
    !context.parentURL.includes("/node_modules/")
  )
    base = fileURLToPath(new URL(specifier, context.parentURL));
  if (!base) return nextResolve(specifier, context);
  if (!isFile(base))
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
      if (isFile(candidate))
        return nextResolve(pathToFileURL(candidate).href, context);
  return nextResolve(pathToFileURL(base).href, context);
}
