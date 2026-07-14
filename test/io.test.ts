import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timestampForFile, writeTextOutput } from "../src/io";

describe("io", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ask-chat-cli-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("creates parent directories for output files", async () => {
    const output = path.join(tempDir, "nested", "plan.md");
    await expect(writeTextOutput("hello", { output })).resolves.toBe(output);
    await expect(fs.promises.readFile(output, "utf8")).resolves.toBe("hello");
  });

  it("refuses to overwrite existing files", async () => {
    const output = path.join(tempDir, "plan.md");
    await fs.promises.writeFile(output, "old", "utf8");

    await expect(writeTextOutput("new", { output })).rejects.toThrow("Refusing to overwrite");
    await expect(fs.promises.readFile(output, "utf8")).resolves.toBe("old");
  });

  it("writes to stdout with a trailing newline", async () => {
    let text = "";
    await writeTextOutput("hello", {
      stdout: {
        write(chunk: string) {
          text += chunk;
        }
      }
    });

    expect(text).toBe("hello\n");
  });

  it("formats timestamps for filenames", () => {
    expect(timestampForFile(new Date(2026, 5, 26, 3, 4, 5))).toBe("20260626-030405");
  });
});

