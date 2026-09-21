import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/contracts.ts";
import {
  admitRequestMember,
  type RequestMemberTask,
  recordRequestDependency,
} from "../../src/requests/aggregate.ts";
import { parseRequestDeliveryRecord } from "../../src/requests/delivery-codec.ts";
import {
  createRequestDeliveryStore,
  type RequestDeliveryStore,
} from "../../src/requests/delivery-store.ts";
import { StateCorruptionError, TaskStoreError } from "../../src/tasks/store-errors.ts";

const NOW = "2030-01-01T00:00:00.000Z";
const REQUEST_ID = "req-1";

function memberTask(id: string): RequestMemberTask {
  return { id, kind: "implementation", stage: "queued", surfaces: ["api"], requestId: REQUEST_ID };
}

async function withHome(
  body: (newStore: () => RequestDeliveryStore) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tandem-request-delivery-store-")));
  const home = join(root, "home");
  const clock: Clock = () => NOW;
  try {
    await body(() => createRequestDeliveryStore({ home, clock }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("request membership and relations survive a new store over the same database", async () => {
  await withHome(async (newStore) => {
    const opened = await newStore().open({ requestId: REQUEST_ID, repoPath: "/repo" });
    const admitted = await newStore().update(REQUEST_ID, opened.revision, (record) =>
      admitRequestMember(
        record,
        {
          task: memberTask("task-1"),
          briefRevision: 1,
          agreementDigest: "agreement-1",
          approvalState: "current",
        },
        NOW,
      ),
    );
    const second = await newStore().update(REQUEST_ID, admitted.revision, (record) =>
      admitRequestMember(
        record,
        {
          task: memberTask("task-2"),
          briefRevision: 1,
          agreementDigest: "agreement-1",
          approvalState: "current",
        },
        NOW,
      ),
    );
    await newStore().update(REQUEST_ID, second.revision, (record) =>
      recordRequestDependency(
        record,
        { taskId: "task-2", dependsOn: "task-1", reason: "needs the endpoint", briefRevision: 1 },
        NOW,
      ),
    );

    const reread = await newStore().read(REQUEST_ID);
    expect(reread?.members.map((member) => member.taskId)).toEqual(["task-1", "task-2"]);
    expect(reread?.dependencies[0]).toMatchObject({
      taskId: "task-2",
      dependsOn: "task-1",
      status: "active",
    });
    expect(await newStore().list()).toHaveLength(1);
  });
});

test("opening an existing request returns its record instead of replacing it", async () => {
  await withHome(async (newStore) => {
    const opened = await newStore().open({ requestId: REQUEST_ID, repoPath: "/repo" });
    const admitted = await newStore().update(REQUEST_ID, opened.revision, (record) =>
      admitRequestMember(
        record,
        {
          task: memberTask("task-1"),
          briefRevision: 1,
          agreementDigest: "agreement-1",
          approvalState: "current",
        },
        NOW,
      ),
    );

    const reopened = await newStore().open({ requestId: REQUEST_ID, repoPath: "/repo" });
    expect(reopened).toEqual(admitted);
  });
});

test("a concurrent update against a stale revision is refused", async () => {
  await withHome(async (newStore) => {
    const store = newStore();
    const opened = await store.open({ requestId: REQUEST_ID, repoPath: "/repo" });
    await store.update(REQUEST_ID, opened.revision, (record) =>
      admitRequestMember(
        record,
        {
          task: memberTask("task-1"),
          briefRevision: 1,
          agreementDigest: "agreement-1",
          approvalState: "current",
        },
        NOW,
      ),
    );

    await expect(
      store.update(REQUEST_ID, opened.revision, (record) =>
        admitRequestMember(
          record,
          {
            task: memberTask("task-2"),
            briefRevision: 1,
            agreementDigest: "agreement-1",
            approvalState: "current",
          },
          NOW,
        ),
      ),
    ).rejects.toThrow(TaskStoreError);
  });
});

test("an update that skips more than one revision is refused", async () => {
  await withHome(async (newStore) => {
    const store = newStore();
    const opened = await store.open({ requestId: REQUEST_ID, repoPath: "/repo" });

    await expect(
      store.update(REQUEST_ID, opened.revision, (record) => ({
        ...record,
        revision: record.revision + 2,
      })),
    ).rejects.toThrow(/advance revision at most once/u);
  });
});

test("a stored record that admits one task twice fails the read closed", () => {
  const duplicated = {
    schemaVersion: 1,
    id: REQUEST_ID,
    revision: 1,
    repoPath: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    members: [
      {
        taskId: "task-1",
        briefRevision: 1,
        agreementDigest: "agreement-1",
        surfaces: ["api"],
        admittedAt: NOW,
        status: "active",
      },
      {
        taskId: "task-1",
        briefRevision: 1,
        agreementDigest: "agreement-1",
        surfaces: ["api"],
        admittedAt: NOW,
        status: "active",
      },
    ],
    dependencies: [],
    conflicts: [],
    notifications: [],
  };

  expect(() => parseRequestDeliveryRecord(duplicated)).toThrow(StateCorruptionError);
  expect(() => parseRequestDeliveryRecord(duplicated)).toThrow(/admitted twice/u);
});

test("integration evidence that names no validation contract fails the read closed", () => {
  const record = {
    schemaVersion: 1,
    id: REQUEST_ID,
    revision: 1,
    repoPath: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    members: [],
    dependencies: [],
    conflicts: [],
    integration: {
      worktree: {
        root: "/pool",
        path: "/pool/request",
        name: "req-1",
        baseHead: "a".repeat(40),
        branch: "tandem/req-1",
        leaseId: "lease-1",
        leaseHolder: "tandem-req-1",
        leasedAt: NOW,
      },
      baseHead: "a".repeat(40),
      head: "integrated-1",
      members: [{ taskId: "task-1", branch: "tandem/task-1", head: "member-1" }],
      policyDigest: "policy-1",
      ownerSessionId: "session-1",
      integratedAt: NOW,
      evidence: [
        {
          name: "check",
          argv: ["bun", "run", "check"],
          exitCode: 0,
          stdout: "",
          stderr: "",
          head: "integrated-1",
          contract: "legacy",
        },
      ],
      reviews: [],
    },
    notifications: [],
  };

  expect(() => parseRequestDeliveryRecord(record)).toThrow(/must name a validation contract/u);
});
