import { expect, test } from "vitest";
import { hasBearerSecret } from "./bearer";

const SECRET = "s".repeat(40);

test("accepts only the exact bearer secret", () => {
  expect(hasBearerSecret(`Bearer ${SECRET}`, SECRET)).toBe(true);
  expect(hasBearerSecret(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  expect(hasBearerSecret(SECRET, SECRET)).toBe(false);
  expect(hasBearerSecret(null, SECRET)).toBe(false);
  expect(hasBearerSecret("Bearer ", "")).toBe(false);
  expect(hasBearerSecret(`Bearer ${SECRET}`, undefined)).toBe(false);
});
