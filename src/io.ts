import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors";

export interface WritableLike {
  write(chunk: string): unknown;
}

export function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stream.isTTY) {
    return Promise.resolve("");
  }

  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

export async function writeTextOutput(
  text: string,
  options: { output?: string; stdout?: WritableLike } = {}
): Promise<string | undefined> {
  if (!options.output) {
    const stdout = options.stdout || process.stdout;
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    return undefined;
  }

  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath)) {
    throw new CliError(`Refusing to overwrite existing output file: ${outputPath}.`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, text, "utf8");
  return outputPath;
}

export function timestampForFile(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
