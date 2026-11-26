/**
 * Every module specifier a JavaScript module imports statically, sorted: `import x from '…'`,
 * `export … from "…"`, multi-line import lists and bare side-effect imports (`import '…'`), in
 * single or double quotes. build-journal-module.mjs compares the result with a reviewed set.
 * @param {string} source
 * @returns {string[]}
 */
export function journalImports(source) {
  const pattern = /^\s*(?:import|export)\b(?:[^;'"`]*?\bfrom)?\s*(['"])([^'"\n]+)\1/gm;
  return [...source.matchAll(pattern)].map((match) => match[2]).sort();
}
