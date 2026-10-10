import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PresentationObservation } from "../adapters/lavish.ts";
import {
  type PresentationFeedbackEvidence,
  type PresentationRecord,
  readSingleLine,
  validateRecord,
} from "./records.ts";

const FEEDBACK_DIRECTORY = "feedback";

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    // Hard-linking publishes atomically and refuses an occupied destination.
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function feedbackEvidencePath(record: PresentationRecord, eventId: string): string {
  const paths = validateRecord(record);
  const safeEventId = readSingleLine(eventId, "eventId");
  if (!/^[A-Za-z0-9._-]+$/u.test(safeEventId)) {
    throw new TypeError(
      "eventId must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }
  return join(paths.cwd, FEEDBACK_DIRECTORY, `${safeEventId}.json`);
}

export async function writePresentationFeedbackEvidence(input: {
  readonly record: PresentationRecord;
  readonly eventId: string;
  readonly observedAt: string;
  readonly observation: PresentationObservation;
}): Promise<string> {
  const eventId = readSingleLine(input.eventId, "eventId");
  const observedAt = readSingleLine(input.observedAt, "observedAt");
  const path = feedbackEvidencePath(input.record, eventId);
  const evidence: PresentationFeedbackEvidence = {
    schemaVersion: 1,
    presentationId: input.record.id,
    eventId,
    observedAt,
    observation: input.observation,
  };
  await writePrivateJson(path, evidence);
  return path;
}
