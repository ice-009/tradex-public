import { describe, expect, it } from "vitest";
import { selectSources } from "./selectSources";
import type { DataSource } from "./types";

/** Factories that record which sources were built. */
function registry() {
  const built: string[] = [];
  const make = (id: string) => () => {
    built.push(id);
    return { id, label: id, kind: id === "sample" ? "sample" : "broker", unavailable: async () => null } as DataSource;
  };
  return { built, factories: { hub: make("hub"), sample: make("sample") } };
}

const ids = (sources: DataSource[]) => sources.map((source) => source.id);

describe("selectSources", () => {
  it("uses the hub, then labelled sample data, when a hub is configured", () => {
    const { factories } = registry();
    expect(ids(selectSources({ hub: true, factories }))).toEqual(["hub", "sample"]);
  });

  it("has only sample data without a hub, and never builds the hub source", () => {
    const { built, factories } = registry();
    expect(ids(selectSources({ hub: false, factories }))).toEqual(["sample"]);
    expect(built).not.toContain("hub");
  });

  it("ignores DATA_SOURCES from earlier versions, with a warning", () => {
    const { factories } = registry();
    const warnings: string[] = [];
    expect(ids(selectSources({ hub: true, dataSources: "fyers,eod,sample", factories, warn: (message) => warnings.push(message) }))).toEqual(["hub", "sample"]);
    expect(warnings[0]).toMatch(/no longer used/);
    expect(ids(selectSources({ hub: false, dataSources: "hub", factories, warn: () => {} }))).toEqual(["sample"]);
  });
});
