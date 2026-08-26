const { createExecutionQueue } = require("../../dist/execution-queue.js");

const kind = process.argv[2];
const holdMs = Number(process.argv[3] || 200);
const provider = process.argv[4] || "chatgpt";
const conversationName = process.argv[5] || "release";

async function main() {
  const queue = createExecutionQueue(process.env);
  const lease = kind === "browser"
    ? await queue.acquireBrowserLease({
        headless: false,
        exclusive: true,
        action: "test browser maintenance"
      })
    : kind === "provider-readiness"
    ? await queue.acquireProviderReadinessLease(provider)
    : await queue.acquireConversationLease(provider, conversationName);
  process.stdout.write(`${JSON.stringify({ event: "guard-acquired", id: lease.id })}\n`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await lease.release();
  process.stdout.write(`${JSON.stringify({ event: "guard-released", id: lease.id })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
