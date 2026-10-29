// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { FindingStatusAction } from "./finding-status-action";

afterEach(cleanup);

const renderWith = (
  result: FormState,
  status: "OPEN" | "IGNORED" | "RESOLVED",
) => {
  const sent: Array<{ status: unknown; from: unknown }> = [];
  const action = vi.fn(async (_prev: FormState, form: FormData) => {
    sent.push({ status: form.get("status"), from: form.get("from") });
    return result;
  });
  render(
    <FindingStatusAction
      action={action}
      status={status}
      title="Title too long"
    />,
  );
  return { sent };
};

describe("FindingStatusAction", () => {
  test("open offers Ignore, ignored offers Reopen, resolved offers nothing", () => {
    renderWith(undefined, "OPEN");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Ignore",
    ]);
    cleanup();
    renderWith(undefined, "IGNORED");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Reopen",
    ]);
    cleanup();
    renderWith(undefined, "RESOLVED");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("sends the requested and shown status; success is announced as a status", async () => {
    const { sent } = renderWith({ ok: "Ignored." }, "OPEN");
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    expect((await screen.findByRole("status")).textContent).toBe("Ignored.");
    expect(sent).toEqual([{ status: "IGNORED", from: "OPEN" }]);
  });

  test("a refusal is an alert linked to the button", async () => {
    renderWith(
      { error: "This finding changed after you opened the page." },
      "OPEN",
    );
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed after you opened/);
    expect(
      screen
        .getByRole("button", { name: "Ignore" })
        .getAttribute("aria-describedby"),
    ).toBe(alert.id);
  });
});
