// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ContentPlanPicker } from "./content-plan-picker";

// next/form needs the app router; a plain GET form is what it renders.
vi.mock("next/form", () => ({
  default: ({
    action,
    children,
    className,
  }: {
    action: string;
    children: ReactNode;
    className?: string;
  }) => (
    <form action={action} method="get" className={className}>
      {children}
    </form>
  ),
}));

afterEach(cleanup);

const props = (
  over: Partial<ComponentProps<typeof ContentPlanPicker>> = {},
): ComponentProps<typeof ContentPlanPicker> => ({
  action: "/o/a/websites/w/report",
  period: "28d",
  groups: [
    {
      title: "Explain each service on its own page",
      items: [
        {
          id: "aaaaaaaaaa",
          label: "Describe Funeral flowers on its page",
          detail: "Do first · /funeral-flowers",
        },
      ],
    },
    {
      title: "Help visitors reach service pages",
      items: [
        {
          id: "bbbbbbbbbb",
          label: "Link to the Wedding flowers page",
          detail: "Do first · / and 1 more",
        },
      ],
    },
    {
      title: "New pages in the plan",
      items: [
        {
          id: "cccccccccc",
          label: "Add a page for “Cottages”",
          detail: "New page",
        },
      ],
    },
  ],
  selected: ["aaaaaaaaaa", "cccccccccc"],
  available: 3,
  explicit: true,
  stale: 0,
  allHref: "/o/a/websites/w/report?period=28d&content=include",
  noneHref: "/o/a/websites/w/report?period=28d&content=include&sel=1",
  ...over,
});

describe("the content plan picker", () => {
  test("grouped checkboxes show what is selected, with available and selected counts", () => {
    render(<ContentPlanPicker {...props()} />);
    expect(screen.getByTestId("selection-count").textContent).toBe(
      "(2 of 3 selected)",
    );
    expect(
      screen.getByText(/available items are selected for this report/),
    ).toBeTruthy();
    // <details> is a "group" too; the item groups are fieldsets.
    const groups = [...document.querySelectorAll("fieldset")];
    expect(groups.map((g) => g.querySelector("legend")!.textContent)).toEqual([
      "Explain each service on its own page",
      "Help visitors reach service pages",
      "New pages in the plan",
    ]);
    const box = (name: RegExp) =>
      screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box(/Describe Funeral flowers/).checked).toBe(true);
    expect(box(/Link to the Wedding flowers/).checked).toBe(false);
    expect(box(/Cottages/).checked).toBe(true);
  });

  test("the form carries the period, inclusion and explicit-selection marker; boxes submit their ids", () => {
    const { container } = render(<ContentPlanPicker {...props()} />);
    const form = container.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/o/a/websites/w/report");
    const hidden = Object.fromEntries(
      [...form.querySelectorAll<HTMLInputElement>("input[type=hidden]")].map(
        (i) => [i.name, i.value],
      ),
    );
    expect(hidden).toEqual({ period: "28d", content: "include", sel: "1" });
    expect(
      [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map(
        (i) => [i.name, i.value],
      ),
    ).toEqual([
      ["pick", "aaaaaaaaaa"],
      ["pick", "bbbbbbbbbb"],
      ["pick", "cccccccccc"],
    ]);
    expect(
      screen.getByRole("button", { name: "Apply selection" }),
    ).toBeTruthy();
  });

  test("ticking a box submits the form at once", () => {
    const submit = vi.fn();
    const { container } = render(<ContentPlanPicker {...props()} />);
    const form = container.querySelector("form")!;
    form.requestSubmit = submit;
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Link to the Wedding flowers/ }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("select all and clear all are plain links", () => {
    render(<ContentPlanPicker {...props()} />);
    expect(
      screen.getByRole("link", { name: "Select all" }).getAttribute("href"),
    ).toBe("/o/a/websites/w/report?period=28d&content=include");
    expect(
      screen.getByRole("link", { name: "Clear all" }).getAttribute("href"),
    ).toBe("/o/a/websites/w/report?period=28d&content=include&sel=1");
  });

  test("explicit selections say new items are not added; ignored ids are reported", () => {
    render(<ContentPlanPicker {...props({ stale: 2 })} />);
    expect(screen.getByText(/not added automatically/)).toBeTruthy();
    expect(screen.getByTestId("selection-stale").textContent).toMatch(
      /2 earlier selections/,
    );
    cleanup();
    render(
      <ContentPlanPicker
        {...props({
          explicit: false,
          selected: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"],
        })}
      />,
    );
    expect(screen.queryByText(/not added automatically/)).toBeNull();
    expect(screen.queryByTestId("selection-stale")).toBeNull();
    for (const b of within(
      screen.getByTestId("content-plan-picker"),
    ).getAllByRole("checkbox"))
      expect((b as HTMLInputElement).checked).toBe(true);
  });
});
