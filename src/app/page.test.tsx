// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Home from "./page";

test("home page renders the product name", () => {
  render(<Home />);
  expect(
    screen.getByRole("heading", { level: 1, name: "UpSiteHealth" }),
  ).toBeDefined();
});
