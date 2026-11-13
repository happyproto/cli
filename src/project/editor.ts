// crates/hpy/src/project/editor.rs: the editor settings that point a language server at the
// declarations HappyView writes under `.happyview/types/`: `tsconfig.json` for TypeScript and
// JavaScript, `.luarc.json` for LuaLS.
//
// A file the project already has is never rewritten. It may hold settings of the author's own,
// so instead of editing it hpy says what to add when it does not already name the types
// directory.
import { readdirSync, readFileSync } from "node:fs";
import { IoError, readToString, writeString } from "../core/io.ts";
import { type Json, toJson } from "../core/output.ts";
import { rustJoin } from "../core/paths.ts";
import { get, parseValue } from "../core/serde-json.ts";

const TYPES_DIR = ".happyview/types";

/** The language ids of the interpreters placed in the project, sorted, as their manifests name them. */
export function languages(root: string): string[] {
  let names: string[];
  const plugins = rustJoin(root, ".happyview", "plugins");
  try {
    names = readdirSync(plugins);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      const bytes = readFileSync(rustJoin(plugins, name, "manifest.json"));
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      continue;
    }
    let manifest: ReturnType<typeof parseValue>;
    try {
      manifest = parseValue(text);
    } catch {
      continue;
    }
    const kind = get(manifest, "plugin_type");
    if (kind?.kind !== "string" || kind.value !== "interpreter") continue;
    const id = get(manifest, "language_id");
    if (id?.kind === "string") found.push(id.value);
  }
  // `Vec<String>::sort` is byte order; `dedup` drops adjacent repeats.
  found.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return found.filter((l, i) => i === 0 || l !== found[i - 1]);
}

/** One settings file a language server reads. */
interface Settings {
  name: string;
  /** The directory it has to name, which is how an existing one is judged. */
  types: string;
  /** Where in an existing file the directory goes, for the line saying so. */
  place: string;
  config: Json;
}

function settings(languages: readonly string[]): Settings[] {
  const has = (id: string) => languages.includes(id);
  const out: Settings[] = [];

  // Both front ends render the same modules, and a program that included both directories
  // would declare each twice.
  const script = has("typescript") ? "typescript" : has("javascript") ? "javascript" : undefined;
  if (script !== undefined) {
    const types = `${TYPES_DIR}/${script}`;
    out.push({
      name: "tsconfig.json",
      place: "its include",
      config: {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "es2022",
          module: "es2022",
          moduleResolution: "bundler",
          lib: ["es2022"],
          types: [],
          allowJs: true,
          checkJs: has("javascript"),
        },
        include: ["src", types],
      },
      types,
    });
  }

  if (has("lua")) {
    const types = `${TYPES_DIR}/lua`;
    out.push({
      name: ".luarc.json",
      place: "its workspace.library",
      config: {
        $schema: "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json",
        "runtime.version": "Lua 5.4",
        "workspace.library": [types],
        "workspace.ignoreDir": [".happyview"],
        // What a handler defines and what a test file is given; HappyView calls the first and
        // supplies the rest.
        "diagnostics.globals": [
          "handle",
          "describe",
          "it",
          "pending",
          "before_each",
          "after_each",
          "test",
        ],
      },
      types,
    });
  }
  return out;
}

/** `serde_json::to_string_pretty` of the `Value` (keys sorted), then a newline. */
function text(config: Json): string {
  return `${toJson(config)}\n`;
}

/** The settings files a new project with `languages` starts with, as `[path, contents]`. */
export function editorFiles(languages: readonly string[]): [string, string][] {
  return settings(languages).map((s) => [s.name, text(s.config)]);
}

/**
 * Write whichever settings files `languages` need and the project lacks. Answers a line for
 * each file written and each existing one that does not name its types directory. Throws an
 * `IoError`.
 */
export function writeEditorConfig(root: string, languages: readonly string[]): string[] {
  const lines: string[] = [];
  for (const s of settings(languages)) {
    const path = rustJoin(root, s.name);
    let existing: string | undefined;
    try {
      existing = readToString(path);
    } catch (e) {
      if (!(e instanceof IoError) || e.code !== "ENOENT") throw e;
      existing = undefined;
    }
    if (existing !== undefined) {
      if (!existing.includes(s.types))
        lines.push(`${s.name} does not name ${s.types}; add it to ${s.place} for editor types`);
      continue;
    }
    writeString(path, text(s.config));
    lines.push(`wrote ${s.name}, which points editors at ${s.types}`);
  }
  return lines;
}
