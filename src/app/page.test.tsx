// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Home from "./page";

test("home page shows the brand, the value proposition and both calls to action", () => {
  render(<Home />);
  expect(screen.getAllByText("UpSiteHealth").length).toBeGreaterThan(0);
  expect(
    screen.getByRole("heading", { level: 1, name: /what to fix/i }),
  ).toBeDefined();
  expect(
    screen.getByRole("link", { name: "Create account" }).getAttribute("href"),
  ).toBe("/signup");
  expect(
    screen
      .getAllByRole("link", { name: "Sign in" })
      .every((a) => a.getAttribute("href") === "/login"),
  ).toBe(true);
});
