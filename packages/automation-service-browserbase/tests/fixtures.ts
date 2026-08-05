export function navigationWorkflow() {
  const timestamp = "2026-08-02T12:00:00.000Z";
  return {
    schemaVersion: "1.3",
    id: "11111111-1111-4111-8111-111111111111",
    name: "Service navigation fixture",
    status: "complete",
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp,
    source: {
      provider: "browserbase",
      sessionId: "private-recording-session-id",
      startUrl: "https://example.com",
    },
    steps: [
      {
        id: "navigate",
        order: 0,
        name: "Open example",
        enabled: true,
        page: { id: "page-1", url: "https://example.com" },
        metadata: { recordedAt: timestamp, origin: "recorded", sensitive: false },
        type: "navigate",
        payload: { url: "https://example.com" },
      },
    ],
  };
}
