import { afterEach, describe, expect, test, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { isMissingFactsTable, readFacts } from "./load";

const prismaError = (code: string, modelName: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "test",
    meta: { modelName },
  });
const missing = prismaError(
  "P2021",
  "BusinessFact",
  "The table `public.business_facts` does not exist in the current database.",
);

afterEach(() => vi.restoreAllMocks());

describe("business facts on a database without the migration", () => {
  test("only a missing business_facts table is recognised", () => {
    expect(isMissingFactsTable(missing)).toBe(true);
    expect(
      isMissingFactsTable(
        prismaError(
          "P2021",
          "Recommendation",
          "The table `public.recommendations` does not exist",
        ),
      ),
    ).toBe(false);
    expect(
      isMissingFactsTable(
        prismaError("P2002", "BusinessFact", "Unique constraint"),
      ),
    ).toBe(false);
    expect(isMissingFactsTable(new Error("business_facts"))).toBe(false);
  });

  test("readFacts returns null and logs an error; every other failure is rethrown", async () => {
    const error = vi.spyOn(log, "error").mockImplementation(() => {});
    expect(await readFacts(() => Promise.reject(missing))).toBeNull();
    expect(error).toHaveBeenCalledWith("business_facts.unavailable", {
      reason:
        "table missing: apply migration 1_business_facts to this database",
    });
    const other = prismaError(
      "P1001",
      "BusinessFact",
      "Can't reach database server",
    );
    await expect(readFacts(() => Promise.reject(other))).rejects.toBe(other);
    expect(await readFacts(() => Promise.resolve([1]))).toEqual([1]);
  });
});
