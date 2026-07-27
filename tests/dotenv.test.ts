import { describe, expect, it } from "vitest";
import { serializeDotenv } from "../src/core/dotenv.js";

describe("serializeDotenv", () => {
  it("emits sorted bare values", () => {
    expect(serializeDotenv({ B: "2", A: "1" })).toBe("A=1\nB=2\n");
  });

  it("quotes values with significant characters", () => {
    expect(serializeDotenv({ URL: "a b#c" })).toBe('URL="a b#c"\n');
  });

  it("quotes empty values", () => {
    expect(serializeDotenv({ A: "" })).toBe('A=""\n');
  });

  it("returns an empty string for no vars", () => {
    expect(serializeDotenv({})).toBe("");
  });
});
