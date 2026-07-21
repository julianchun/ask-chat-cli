import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const describeLive = process.env.ASK_LIVE_TEST === "1" ? describe : describe.skip;

describeLive("live ChatGPT parallel smoke test", () => {
  it("returns isolated responses and distinct conversation URLs for six prompts", async () => {
    const cli = path.resolve(__dirname, "..", "dist", "cli.js");
    const runId = `${Date.now().toString(36)}-${process.pid}`;
    const cases = Array.from({ length: 6 }, (_, index) => ({
      name: `live-${runId}-${index + 1}`,
      token: `ASK_PARALLEL_${runId.toUpperCase()}_${index + 1}`
    }));

    const results = await Promise.all(cases.map(({ name, token }) => runCli(cli, [
      "--provider", "chatgpt",
      "--conversation", name,
      "--timeout", "180000",
      `Reply with exactly this token and nothing else: ${token}`
    ])));

    try {
      for (const [index, result] of results.entries()) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain(cases[index].token);
      }
      expect(results.filter((result) => result.stderr.includes("queued")).length).toBeGreaterThanOrEqual(2);

      const listed = await execFileAsync(process.execPath, [
        cli, "conversations", "list", "--provider", "chatgpt", "--json"
      ], { env: process.env, maxBuffer: 1024 * 1024 });
      const conversations = JSON.parse(listed.stdout) as Array<{ name: string; url: string }>;
      const urls = cases.map(({ name }) => conversations.find((entry) => entry.name === name)?.url);
      expect(urls.every((url): url is string => Boolean(url))).toBe(true);
      expect(new Set(urls).size).toBe(6);
    } finally {
      await Promise.all(cases.map(({ name }) => execFileAsync(process.execPath, [
        cli, "conversations", "forget", name, "--provider", "chatgpt"
      ], { env: process.env }).catch(() => undefined)));
    }
  }, 5 * 60 * 1000);
});

function runCli(cli: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
