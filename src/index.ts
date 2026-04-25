#!/usr/bin/env node
/**
 * mcp-dotnet — MCP server that wraps ILSpy's `ilspycmd` so an LLM can list
 * types and decompile .NET assemblies (including .NET 6+ single-file
 * deployments) into readable C#. No runtime execution of the target binary
 * happens at any point - everything goes through the static decompiler.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { runIlspy } from "./ilspy.js";

const server = new Server(
  { name: "mcp-dotnet", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list-types",
      description:
        "List declared types in a .NET assembly (classes, interfaces, structs, delegates, enums). " +
        "Use this first to find candidates before calling decompile-type. Works on .dll, .exe, " +
        "and .NET 6+ single-file deployments (the embedded core assembly is decompiled directly).",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute path to the assembly." },
          kinds: {
            type: "string",
            description:
              "Comma-separated subset of: c (class), i (interface), s (struct), d (delegate), e (enum). " +
              "Default: 'c,i,s,d,e'.",
          },
        },
      },
    },
    {
      name: "decompile-type",
      description:
        "Decompile a single fully-qualified type into C# source. Pass the fully qualified " +
        "name as printed by list-types (e.g. 'Acme.Bot.LicenseManager').",
      inputSchema: {
        type: "object",
        required: ["path", "type"],
        properties: {
          path: { type: "string", description: "Absolute path to the assembly." },
          type: {
            type: "string",
            description: "Fully-qualified type name to decompile.",
          },
          languageVersion: {
            type: "string",
            description:
              "C# language version. Default: Latest. Useful values: CSharp7_3, CSharp10_0, Latest.",
          },
          includeIl: {
            type: "boolean",
            description: "Append IL alongside the C# (ilspycmd -il). Default: false.",
            default: false,
          },
        },
      },
    },
    {
      name: "decompile-assembly",
      description:
        "Decompile the entire assembly into a folder of .cs files (a compilable project). " +
        "Use this when you want to grep across the whole codebase. Returns the output directory " +
        "and a flat list of generated files. Heavy - prefer list-types + decompile-type for targeted lookups.",
      inputSchema: {
        type: "object",
        required: ["path", "outDir"],
        properties: {
          path: { type: "string", description: "Absolute path to the assembly." },
          outDir: {
            type: "string",
            description: "Absolute path where the decompiled project tree should be written.",
          },
        },
      },
    },
    {
      name: "search-source",
      description:
        "Decompile the assembly to a temporary directory then grep its C# source for a pattern. " +
        "Returns the matching files with line snippets. The decompiled tree is preserved on disk " +
        "for follow-up queries (path returned in 'outDir').",
      inputSchema: {
        type: "object",
        required: ["path", "pattern"],
        properties: {
          path: { type: "string", description: "Absolute path to the assembly." },
          outDir: {
            type: "string",
            description:
              "Optional output directory to reuse; otherwise a temp dir under the assembly's directory is created.",
          },
          pattern: {
            type: "string",
            description: "JavaScript regex pattern. Case-insensitive flag is implied.",
          },
          maxMatches: { type: "integer", default: 200 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "list-types":
        return await listTypes(strArg(args, "path"), strOpt(args, "kinds", "c,i,s,d,e"));

      case "decompile-type":
        return await decompileType(
          strArg(args, "path"),
          strArg(args, "type"),
          strOpt(args, "languageVersion", "Latest"),
          boolOpt(args, "includeIl", false)
        );

      case "decompile-assembly":
        return await decompileAssembly(strArg(args, "path"), strArg(args, "outDir"));

      case "search-source":
        return await searchSource(
          strArg(args, "path"),
          strArg(args, "pattern"),
          strOpt(args, "outDir", ""),
          intOpt(args, "maxMatches", 200)
        );

      default:
        return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true };
  }
});

async function listTypes(asm: string, kinds: string) {
  ensureExists(asm);
  const r = await runIlspy(["-l", kinds, asm]);
  if (r.code !== 0) throw new Error(`ilspycmd exit ${r.code}: ${r.stderr || r.stdout}`);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return text({ assembly: asm, kindsFilter: kinds, count: lines.length, types: lines });
}

async function decompileType(asm: string, type: string, lang: string, includeIl: boolean) {
  ensureExists(asm);
  const args = ["-t", type, "-lv", lang];
  if (includeIl) args.push("-il");
  args.push(asm);
  const r = await runIlspy(args, { timeoutMs: 240_000 });
  if (r.code !== 0) throw new Error(`ilspycmd exit ${r.code}: ${r.stderr || r.stdout}`);
  return {
    content: [
      { type: "text", text: r.stdout },
      {
        type: "text",
        text: JSON.stringify({ assembly: asm, type, languageVersion: lang, ilIncluded: includeIl }, null, 2),
      },
    ],
  };
}

async function decompileAssembly(asm: string, outDir: string) {
  ensureExists(asm);
  const r = await runIlspy(["-p", "-o", outDir, asm], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new Error(`ilspycmd exit ${r.code}: ${r.stderr || r.stdout}`);
  const files = await walk(outDir);
  return text({
    assembly: asm,
    outDir,
    fileCount: files.length,
    sampleFiles: files.slice(0, 50),
    truncated: files.length > 50,
  });
}

async function searchSource(asm: string, pattern: string, outDirHint: string, maxMatches: number) {
  ensureExists(asm);
  const outDir = outDirHint || path.join(path.dirname(asm), `.mcp-dotnet-${path.basename(asm)}`);
  await mkdir(outDir, { recursive: true });
  /* Decompile only if the directory is empty so repeated searches reuse work. */
  const existing = await readdir(outDir).catch(() => [] as string[]);
  if (existing.length === 0) {
    const r = await runIlspy(["-p", "-o", outDir, asm], { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`ilspycmd exit ${r.code}: ${r.stderr || r.stdout}`);
  }
  const files = await walk(outDir);
  const re = new RegExp(pattern, "i");
  const matches: Array<{ file: string; line: number; snippet: string }> = [];
  for (const f of files) {
    if (matches.length >= maxMatches) break;
    if (!/\.(cs|csproj|xml)$/i.test(f)) continue;
    const data = await readFile(f, "utf8").catch(() => "");
    if (!data) continue;
    const lines = data.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: f, line: i + 1, snippet: lines[i].trim().slice(0, 240) });
        if (matches.length >= maxMatches) break;
      }
    }
  }
  return text({
    assembly: asm,
    outDir,
    pattern,
    fileCount: files.length,
    matchCount: matches.length,
    cached: existing.length !== 0,
    matches,
  });
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function ensureExists(p: string) {
  if (!existsSync(p)) throw new Error(`File not found: ${p}`);
}

function text(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing string argument: ${key}`);
  return v;
}

function strOpt(args: Record<string, unknown>, key: string, def: string): string {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== "string") throw new Error(`bad string for ${key}: ${v}`);
  return v;
}

function boolOpt(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return def;
  return Boolean(v);
}

function intOpt(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad number for ${key}: ${v}`);
  return Math.floor(n);
}

const transport = new StdioServerTransport();
await server.connect(transport);
