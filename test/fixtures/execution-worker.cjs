const { createExecutionQueue } = require("../../dist/execution-queue.js");

const provider = process.argv[2] || "chatgpt";
const holdMs = Number(process.argv[3] || 200);
const conversationName = process.argv[4] || undefined;
const exclusiveProvider = process.argv[5] === "exclusive";

async function main() {
  const queue = createExecutionQueue(process.env);
  const lease = await queue.acquire({
    provider,
    conversationName,
    exclusiveProvider,
    onUpdate(update) {
      process.stdout.write(`${JSON.stringify({ event: update.phase, position: update.position })}\n`);
    }
  });
  process.stdout.write(`${JSON.stringify({ event: "acquired", id: lease.id })}\n`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await lease.release();
  process.stdout.write(`${JSON.stringify({ event: "released", id: lease.id })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
