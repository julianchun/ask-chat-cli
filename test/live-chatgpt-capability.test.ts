import { describe, expect, it } from "vitest";
import { AskApp } from "../src/app";

const describeLive = process.env.ASK_LIVE_CAPABILITY_TEST === "1" ? describe : describe.skip;

describeLive("live ChatGPT capability smoke test", () => {
  it("inspects a ready managed ChatGPT page without sending", async () => {
    const app = new AskApp({ env: process.env });
    const report = await app.status({
      provider: "chatgpt",
      timeoutMs: 15_000,
      verbose: true
    });

    expect(report.session).toMatchObject({
      connected: true,
      sessionOwnership: "ask-managed"
    });
    expect(report.providers).toMatchObject([
      {
        provider: "chatgpt",
        status: "ready",
        authState: "signed-in-likely",
        messageBox: "available",
        readyToSend: true
      }
    ]);
  }, 20_000);
});
