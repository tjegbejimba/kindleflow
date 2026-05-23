#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  runLatest,
  runLogin,
  runRetry,
  runSend,
  runSendBatch,
  runStatus,
  type CliDeps
} from "./commands.js";

const deps: CliDeps = {
  io: {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code: number) => process.exit(code) as never,
    env: process.env
  }
};

const program = new Command();
program.name("kindleflow").description("KindleFlow CLI").version("0.1.0");

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option("--url <url>", "KindleFlow server URL (overrides env KINDLEFLOW_URL)")
    .option("--token <token>", "API token (overrides env KINDLEFLOW_TOKEN)");
}

addCommonOptions(
  program
    .command("send <url>")
    .description("Import a URL, generate an EPUB, and (optionally) auto-send to Kindle")
    .option("--no-send", "Generate but do not send to Kindle")
    .option("--title <title>", "Override the article title")
).action(async (url: string, options) => {
  await runSend(deps, {
    url: options.url,
    token: options.token,
    noSend: options.send === false,
    title: options.title,
    positional: url
  });
});

addCommonOptions(
  program
    .command("send-batch <file>")
    .description("Read newline-delimited URLs from <file> and import each in turn")
    .option("--no-send", "Generate but do not send to Kindle")
).action(async (file: string, options) => {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    process.stderr.write(`error: could not read ${file}: ${(err as Error).message}\n`);
    process.exit(3);
  }
  const urls = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (urls.length === 0) {
    process.stderr.write("error: no URLs found in input file\n");
    process.exit(3);
  }
  await runSendBatch(deps, {
    url: options.url,
    token: options.token,
    noSend: options.send === false,
    urls
  });
});

addCommonOptions(
  program
    .command("latest")
    .description("List recent imported items and their delivery status")
    .option("--limit <n>", "Number of items to return", (value) => Number(value), 25)
).action(async (options) => {
  await runLatest(deps, { url: options.url, token: options.token, limit: options.limit });
});

addCommonOptions(
  program
    .command("retry <deliveryId>")
    .description("Retry a failed Kindle delivery")
).action(async (deliveryId: string, options) => {
  await runRetry(deps, { url: options.url, token: options.token, deliveryId });
});

addCommonOptions(program.command("status").description("Show server reachability and recent deliveries"))
  .action(async (options) => {
    await runStatus(deps, { url: options.url, token: options.token });
  });

program
  .command("login")
  .description("Save a KindleFlow URL + token to ~/.config/kindleflow/config.yaml")
  .option("--url <url>", "KindleFlow server URL")
  .requiredOption("--token <token>", "Personal API token (mint in the web UI)")
  .action(async (options) => {
    await runLogin(deps, { url: options.url, token: options.token });
  });

await program.parseAsync(process.argv);
