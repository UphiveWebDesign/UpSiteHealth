// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FormState } from "@/app/(app)/o/[orgSlug]/actions";
import { AttentionNotices, ReopenFromOverview } from "./attention-reopen";

afterEach(cleanup);

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
const HREF = "/o/a/websites/w/recommendations#task-t";

function renderReopen(action: Action) {
  return render(
    <AttentionNotices>
      <ReopenFromOverview
        action={action}
        title="Title is too long"
        href={HREF}
      />
    </AttentionNotices>,
  );
}

describe("ReopenFromOverview", () => {
  test("submits exactly the Recommendations page's Reopen: status PROPOSED from COMPLETED", async () => {
    const action = vi.fn<Action>(async () => ({ ok: "Reopened." }));
    renderReopen(action);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const form = action.mock.calls[0][1];
    expect(form.get("status")).toBe("PROPOSED");
    expect(form.get("from")).toBe("COMPLETED");
  });

  test("success: a notice that survives the entry disappearing, with a link to the task", async () => {
    // The refresh after a success removes the entry: model it.
    function Page() {
      const [shown, setShown] = useState(true);
      return (
        <AttentionNotices>
          {shown && (
            <ReopenFromOverview
              action={async () => {
                setShown(false);
                return { ok: "Reopened." };
              }}
              title="Title is too long"
              href={HREF}
            />
          )}
        </AttentionNotices>
      );
    }
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain(
      "Reopened. “Title is too long” is back on the to-do list.",
    );
    expect(
      screen.getByRole("link", { name: "Open task" }).getAttribute("href"),
    ).toBe(HREF);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a refusal from the server is shown as an error, and the task can be checked", async () => {
    renderReopen(async () => ({
      error:
        "This task changed after you opened the page (it is now to do), so nothing was changed. Check it and try again.",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/“Title is too long”: This task changed/);
  });

  test("a failed request never claims nothing changed", async () => {
    renderReopen(async () => {
      throw new Error("network");
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /did not complete\. Open the task to check/,
    );
  });

  test("while a request runs the button is disabled, so a second click sends nothing", async () => {
    let finish: (v: FormState) => void = () => {};
    const action = vi.fn<Action>(
      () => new Promise<FormState>((resolve) => (finish = resolve)),
    );
    renderReopen(action);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    const busy = await screen.findByRole("button", { name: "Reopening…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    await act(async () => finish({ ok: "Reopened." }));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
