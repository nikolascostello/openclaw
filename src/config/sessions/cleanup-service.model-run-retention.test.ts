import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const maintenanceState = vi.hoisted(() => ({
  modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
  maxEntries: 2,
}));

vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: () => ({
    mode: "enforce",
    pruneAfterMs: 30 * DAY_MS,
    archiveDashboardAfterMs: null,
    modelRunPruneAfterMs: maintenanceState.modelRunPruneAfterMs,
    maxEntries: maintenanceState.maxEntries,
    preserveRecentMs: null,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  }),
}));

import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntrySync } from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions cleanup model-run preview", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([
    { modelRunPruneAfterMs: DAY_MS, maxEntries: 2, modelRunPruned: 1, archived: 0 },
    { modelRunPruneAfterMs: 0, maxEntries: 2, modelRunPruned: 0, archived: 1 },
    { modelRunPruneAfterMs: -DAY_MS, maxEntries: 2, modelRunPruned: 0, archived: 1 },
    { modelRunPruneAfterMs: DAY_MS, maxEntries: 3, modelRunPruned: 0, archived: 0 },
  ])(
    "previews model-run retention $modelRunPruneAfterMs under active cap $maxEntries",
    async ({ modelRunPruneAfterMs, maxEntries, modelRunPruned, archived }) => {
      maintenanceState.modelRunPruneAfterMs = modelRunPruneAfterMs;
      maintenanceState.maxEntries = maxEntries;
      const storePath = path.join(
        tempDirs.make("openclaw-cleanup-model-run-"),
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const modelRunSessionKey =
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
      const oldSessionKey = "agent:main:old";
      const now = Date.now();
      replaceSessionEntrySync(
        { sessionKey: modelRunSessionKey, storePath },
        { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
      );
      replaceSessionEntrySync(
        { sessionKey: oldSessionKey, storePath },
        { sessionId: "session-old", updatedAt: now - 3 * DAY_MS },
      );
      replaceSessionEntrySync(
        { sessionKey: "agent:main:active", storePath },
        { sessionId: "session-active", updatedAt: now },
      );
      replaceSessionEntrySync(
        { sessionKey: "agent:main:archived", storePath },
        { sessionId: "session-archived", updatedAt: now - 3 * DAY_MS, archivedAt: now },
      );

      const result = await runSessionsCleanup({
        cfg: {},
        opts: { dryRun: true, enforce: true },
        targets: [{ agentId: "main", storePath }],
      });

      const preview = result.previewResults[0];
      expect(preview?.summary).toMatchObject({
        modelRunPruned,
        capped: 0,
        archived,
        afterCount: 4 - modelRunPruned,
        afterActiveCount: maxEntries,
      });
      expect(preview?.modelRunPrunedKeys.has(modelRunSessionKey)).toBe(modelRunPruned === 1);
      expect(preview?.archivedKeys?.get(oldSessionKey)).toBe(
        archived ? "archive-overflow" : undefined,
      );
    },
  );
});
