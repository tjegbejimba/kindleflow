// Resolves and persists the CLI's configuration (URL + token).
// Precedence: explicit flag → env (KINDLEFLOW_URL/KINDLEFLOW_TOKEN) → config file.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface CliConfig {
  url: string;
  token: string;
}

export interface ResolveOptions {
  flagUrl?: string;
  flagToken?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export function defaultConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "kindleflow", "config.yaml");
}

export async function loadCliConfig(opts: ResolveOptions = {}): Promise<Partial<CliConfig>> {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? defaultConfigPath();

  const fromFile = await readConfigFile(configPath);
  const url = nonEmpty(opts.flagUrl) ?? nonEmpty(env.KINDLEFLOW_URL) ?? fromFile.url;
  const token = nonEmpty(opts.flagToken) ?? nonEmpty(env.KINDLEFLOW_TOKEN) ?? fromFile.token;
  return { url: url?.replace(/\/$/, ""), token };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

export async function readConfigFile(configPath: string): Promise<Partial<CliConfig>> {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = parseYaml(text) as Partial<CliConfig> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Partial<CliConfig> = {};
    if (typeof parsed.url === "string") result.url = parsed.url;
    if (typeof parsed.token === "string") result.token = parsed.token;
    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw err;
  }
}

export async function writeConfigFile(configPath: string, config: CliConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const yaml = stringifyYaml({ url: config.url, token: config.token });
  await writeFile(configPath, yaml, { encoding: "utf8", mode: 0o600 });
}

export async function configFileMode(configPath: string): Promise<number | null> {
  try {
    const s = await stat(configPath);
    return s.mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}
