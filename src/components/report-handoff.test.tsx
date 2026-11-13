// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AutoPrint, CopyClientLink } from "./report-handoff";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PATH = "/o/a/websites/w/report?period=28d&through=2026-11-12";

describe("copy client link", () => {
  test("copies the absolute link and says nothing was sent", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<CopyClientLink path={PATH} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy client link" }));
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${PATH}`);
    expect(screen.getByRole("status").textContent).toMatch(
      /Link copied\. Nothing has been sent/,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("when copying fails, says so and shows the link to copy by hand", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    render(<CopyClientLink path={PATH} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy client link" }));
    });
    expect(screen.getByRole("status").textContent).toMatch(/Could not copy/);
    expect(
      (screen.getByRole("textbox", { name: "Client link" }) as HTMLInputElement)
        .value,
    ).toBe(`${window.location.origin}${PATH}`);
  });
});

describe("save as PDF", () => {
  beforeEach(() => replace.mockReset());

  test("opens the print dialog once, even when effects run twice, then drops the request from the URL", () => {
    vi.useFakeTimers();
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(
      <StrictMode>
        <AutoPrint cleanHref="/o/a/websites/w/report?view=client" />
      </StrictMode>,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(print).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/o/a/websites/w/report?view=client", {
      scroll: false,
    });
  });
});
