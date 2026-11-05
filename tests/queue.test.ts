// The queue's promises, each as a test. Handlers here are tiny fakes; processAnalysis has its own tests.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "./db";
import { backoffMs, claimNext, complete, enqueue, retryOrFail, runJobs } from "../lib/jobs/queue";
import { NonRetryableError } from "../lib/jobs/errors";

const A = "worker-A";
const B = "worker-B";

// One clock rule, in tests too: anything compared against the claim's now() must come from the DB's clock.
const dbNow = async () => (await prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0].now;

describe("queue", () => {
  beforeEach(resetDb);

  it("claims a QUEUED job, marks it RUNNING for this worker, and counts the attempt", async () => {
    const id = await enqueue("noop", { x: 1 });

    const job = await claimNext(A);
    expect(job?.id).toBe(id);
    expect(job?.payload).toEqual({ x: 1 });
    expect(job?.attempts).toBe(1);

    const row = await prisma.job.findUnique({ where: { id } });
    expect(row).toMatchObject({ status: "RUNNING", lockedBy: A });
    expect(row?.lockedAt).not.toBeNull();
  });

  it("returns null when nothing is runnable, including jobs scheduled for the future", async () => {
    await enqueue("noop", {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await claimNext(A)).toBeNull();
  });

  // The SKIP LOCKED proof: ten workers, five jobs, every job claimed exactly once.
  it("concurrent claims hand out distinct jobs", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => enqueue("noop", { i })));

    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimNext(`w${i}`)));
    const claimed = claims.filter((c) => c !== null).map((c) => c!.id);

    expect(claimed).toHaveLength(5);
    expect(new Set(claimed)).toEqual(new Set(ids));
  });

  it("reclaims a RUNNING job whose lease expired, and not one whose lease is fresh", async () => {
    const id = await enqueue("noop", {});
    await claimNext(A);

    expect(await claimNext(B)).toBeNull(); // A's lease is fresh

    await prisma.job.update({ where: { id }, data: { lockedAt: new Date(Date.now() - 10 * 60_000) } }); // 10 min ago
    const reclaimed = await claimNext(B, 5 * 60_000);
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.attempts).toBe(2);
    expect((await prisma.job.findUnique({ where: { id } }))?.lockedBy).toBe(B);
  });

  it("a worker that lost its lease cannot complete or fail the job", async () => {
    const id = await enqueue("noop", {});
    const job = (await claimNext(A))!;
    await prisma.job.update({ where: { id }, data: { lockedAt: new Date(Date.now() - 10 * 60_000) } });
    await claimNext(B); // B holds it now

    expect(await complete(id, A)).toBe(false);
    expect(await retryOrFail(job, A, new Error("late"))).toBe("lost");
    expect((await prisma.job.findUnique({ where: { id } }))).toMatchObject({ status: "RUNNING", lockedBy: B });
  });

  it("a retryable error re-queues with runAt pushed into the future", async () => {
    const id = await enqueue("noop", {});
    const job = (await claimNext(A))!;
    const before = await dbNow();

    expect(await retryOrFail(job, A, new Error("slack: timeout"))).toBe("retry");

    const row = await prisma.job.findUnique({ where: { id } });
    expect(row).toMatchObject({ status: "QUEUED", lockedBy: null, lastError: "Error: slack: timeout" });
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("backoff grows with attempts and never exceeds the cap", () => {
    for (let attempt = 1; attempt <= 20; attempt++) {
      const ms = backoffMs(attempt, 1_000, 60_000);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(Math.min(60_000, 1_000 * 2 ** (attempt - 1)));
    }
  });

  // Done-when item: a job that always fails ends FAILED after N attempts instead of looping forever.
  it("poison job: FAILED after maxAttempts, with the error kept", async () => {
    const id = await enqueue("explode", {}, { maxAttempts: 3 });
    let calls = 0;
    const handlers = { explode: async () => { calls++; throw new Error("always"); } };

    for (let round = 0; round < 10; round++) {
      await prisma.$executeRaw`UPDATE "Job" SET "runAt" = now() WHERE id = ${id} AND status = 'QUEUED'`; // skip the backoff wait
      await runJobs(10, { workerId: A, handlers });
    }

    expect(calls).toBe(3);
    expect(await prisma.job.findUnique({ where: { id } })).toMatchObject({ status: "FAILED", attempts: 3, lastError: "Error: always" });
  });

  it("NonRetryableError fails immediately, on the first attempt", async () => {
    const id = await enqueue("refuse", {}, { maxAttempts: 3 });
    const handlers = { refuse: async () => { throw new NonRetryableError("model refused"); } };

    await runJobs(10, { workerId: A, handlers });

    expect(await prisma.job.findUnique({ where: { id } })).toMatchObject({ status: "FAILED", attempts: 1, lastError: "NonRetryableError: model refused" });
  });

  it("a job type with no handler is FAILED, not retried", async () => {
    const id = await enqueue("mystery", {});
    await runJobs(10, { workerId: A, handlers: {} });
    expect((await prisma.job.findUnique({ where: { id } }))?.status).toBe("FAILED");
  });

  it("runJobs processes up to limit and reports the count", async () => {
    await Promise.all([enqueue("noop", {}), enqueue("noop", {}), enqueue("noop", {})]);
    const handlers = { noop: async () => {} };

    expect(await runJobs(2, { workerId: A, handlers })).toBe(2);
    expect(await runJobs(10, { workerId: A, handlers })).toBe(1);
    expect(await prisma.job.count({ where: { status: "DONE" } })).toBe(3);
  });
});
