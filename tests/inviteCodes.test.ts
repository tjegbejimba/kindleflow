import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileInviteCodes } from "../server/inviteCodes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "kindleflow-invites-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("FileInviteCodes", () => {
  it("accepts each file-backed invite code once and records used codes", async () => {
    const filePath = path.join(tempDir, "invite-codes.txt");
    await writeFile(filePath, "FIRST-CODE\n# comment\nSECOND-CODE\n");
    const invites = new FileInviteCodes(filePath);

    expect(await invites.hasInviteRequirement("fallback")).toBe(true);
    await expect(invites.consume("FIRST-CODE", "reader@example.com", "fallback")).resolves.toBeUndefined();
    await expect(invites.consume("FIRST-CODE", "another@example.com", "fallback")).rejects.toThrow(/invite/i);
    await expect(invites.consume("SECOND-CODE", "another@example.com", "fallback")).resolves.toBeUndefined();

    expect(await readFile(filePath, "utf8")).not.toContain("FIRST-CODE\n");
    expect(await readFile(path.join(tempDir, "invite-codes.used.txt"), "utf8")).toContain("reader@example.com");
  });

  it("falls back to the legacy shared invite code when no invite-code file exists", async () => {
    const invites = new FileInviteCodes(path.join(tempDir, "missing", "invite-codes.txt"));

    expect(await invites.hasInviteRequirement("fallback")).toBe(true);
    await expect(invites.consume("fallback", "reader@example.com", "fallback")).resolves.toBeUndefined();
    await expect(invites.consume("wrong", "reader@example.com", "fallback")).rejects.toThrow(/invite/i);
  });

  it("reports no invite requirement when neither file nor fallback code exists", async () => {
    await mkdir(path.join(tempDir, "empty"));
    const invites = new FileInviteCodes(path.join(tempDir, "empty", "invite-codes.txt"));

    expect(await invites.hasInviteRequirement(undefined)).toBe(false);
  });
});
