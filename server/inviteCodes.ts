import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class FileInviteCodes {
  constructor(private readonly filePath: string) {}

  async hasInviteRequirement(fallbackInviteCode: string | undefined): Promise<boolean> {
    if (await this.fileExists()) {
      return true;
    }
    return Boolean(fallbackInviteCode);
  }

  async consume(inviteCode: string | undefined, email: string, fallbackInviteCode: string | undefined): Promise<void> {
    const normalizedCode = inviteCode?.trim();
    if (!normalizedCode) {
      throw new Error("A valid invite code is required for new users.");
    }

    if (await this.fileExists()) {
      const lines = await this.readLines();
      const codeIndex = lines.findIndex((line) => cleanCode(line) === normalizedCode);
      if (codeIndex === -1) {
        throw new Error("A valid invite code is required for new users.");
      }

      const [usedLine] = lines.splice(codeIndex, 1);
      await this.writeLines(lines);
      await this.appendUsedCode(cleanCode(usedLine), email);
      return;
    }

    if (!fallbackInviteCode || normalizedCode !== fallbackInviteCode) {
      throw new Error("A valid invite code is required for new users.");
    }
  }

  private async fileExists(): Promise<boolean> {
    try {
      await readFile(this.filePath, "utf8");
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async readLines(): Promise<string[]> {
    const content = await readFile(this.filePath, "utf8");
    return content.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  }

  private async writeLines(lines: string[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    await rename(tempPath, this.filePath);
  }

  private async appendUsedCode(code: string, email: string): Promise<void> {
    const usedPath = path.join(path.dirname(this.filePath), "invite-codes.used.txt");
    const existing = await readFile(usedPath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    await writeFile(usedPath, `${existing}${new Date().toISOString()}\t${email}\t${code}\n`);
  }
}

function cleanCode(line: string): string {
  return line.trim().split(/\s+/, 1)[0];
}
