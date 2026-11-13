// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { TaskStatusActions } from "./task-status-actions";

afterEach(cleanup);

const renderWith = (
  result: FormState,
  status: "PROPOSED" | "IN_PROGRESS" | "COMPLETED" | "DISMISSED" = "PROPOSED",
) => {
  const sent: Array<{ status: unknown; from: unknown }> = [];
  const action = vi.fn(async (_prev: FormState, form: FormData) => {
    sent.push({ status: form.get("status"), from: form.get("from") });
    return result;
  });
  render(
    <TaskStatusActions action={action} status={status} title="Fix titles" />,
  );
  return { action, sent };
};

describe("TaskStatusActions", () => {
  test("shows only the changes allowed from the current status", () => {
    renderWith(undefined, "PROPOSED");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Start",
      "Mark done",
      "Dismiss",
    ]);
    cleanup();
    renderWith(undefined, "DISMISSED");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Restore",
    ]);
  });

  test("the clicked button sends its status and the status the page showed", async () => {
    const { sent } = renderWith({ ok: "Dismissed." });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect((await screen.findByRole("status")).textContent).toBe("Dismissed.");
    expect(sent).toEqual([{ status: "DISMISSED", from: "PROPOSED" }]);
  });

  test("a refusal is announced as an alert and linked to the buttons", async () => {
    renderWith({
      error:
        "This task changed after you opened the page (it is now dismissed), so nothing was changed. Check it and try again.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed after you opened the page/);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Start" })
        .getAttribute("aria-describedby"),
    ).toBe(alert.id);
    expect(screen.getByRole("form", { name: /Fix titles/ })).toBeTruthy();
  });
});

describe("action weight", () => {
  const cls = (name: string) => screen.getByRole("button", { name }).className;
  test("the main step is solid, Mark done outlined, Dismiss a quiet separate text button", () => {
    renderWith(undefined, "PROPOSED");
    expect(cls("Start")).toContain("bg-brand-700");
    expect(cls("Mark done")).toContain("border-line-strong");
    expect(cls("Mark done")).not.toContain("bg-brand-700");
    expect(cls("Dismiss")).toContain("text-muted");
    expect(cls("Dismiss")).not.toContain("border-line-strong");
    expect(cls("Dismiss")).toContain("sm:border-l");
  });
  test("in progress: Mark done becomes the main step", () => {
    renderWith(undefined, "IN_PROGRESS");
    expect(cls("Mark done")).toContain("bg-brand-700");
    expect(cls("Stop")).toContain("border-line-strong");
  });
});
