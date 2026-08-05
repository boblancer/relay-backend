import { describe, expect, it } from "vitest";
import { buildAutomationService } from "../src/app.js";
import { loadServiceConfig } from "../src/config.js";
import { navigationWorkflow } from "./fixtures.js";

const enabled = process.env.BROWSERBASE_E2E === "1";
const smoke = enabled ? describe : describe.skip;

smoke("Browserbase HTTP smoke", () => {
  it(
    "navigates through the stateless run endpoint",
    async () => {
      const config = loadServiceConfig(process.env);
      const service = buildAutomationService(config);
      try {
        const response = await service.app.inject({
          method: "POST",
          url: "/v1/run",
          headers: {
            accept: "application/x-ndjson",
            "content-type": "application/json",
          },
          payload: { workflow: navigationWorkflow() },
        });
        const terminal = response.body
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .at(-1);

        expect(response.statusCode).toBe(200);
        expect(terminal).toMatchObject({ type: "worker.outcome", status: "completed" });
      } finally {
        await service.shutdown();
      }
    },
    180_000,
  );
});
