import { describe, expect, it } from "vitest";
import { occupancyNote } from "../src/tools/occupancy.js";

describe("occupancyNote", () => {
  it("says how Xotelo and trivago price children, only when there are children", () => {
    expect(occupancyNote(2, [5, 9])).toMatch(
      /Xotelo cannot price children.*for 4 adults; trivago prices every child as age 6/,
    );
    expect(occupancyNote(4, [])).not.toMatch(/child/);
  });
});
