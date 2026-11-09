import { describe, expect, it } from "vitest";
import { selectSources } from "./selectSources";
import type { DataSource } from "./types";

/** Factories that record which sources were built. */
function registry() {
  const built: string[] = [];
  const make = (id: string) => () => {
    built.push(id);
    return { id, label: id, kind: "broker", unavailable: async () => null } as DataSource;
  };
  return { built, factories: { fyers: make("fyers"), hub: make("hub"), eod: make("eod"), sample: make("sample") } };
}

const ids = (sources: DataSource[]) => sources.map((source) => source.id);

describe("selectSources", () => {
  it("uses Fyers without a hub, and never builds the hub source", () => {
    const { built, factories } = registry();
    expect(ids(selectSources({ hub: false, factories }))).toEqual(["fyers", "eod", "sample"]);
    expect(built).not.toContain("hub");
  });

  it("uses the hub instead of Fyers when one is configured, and never builds the Fyers source", () => {
    const { built, factories } = registry();
    expect(ids(selectSources({ hub: true, factories }))).toEqual(["hub", "eod", "sample"]);
    expect(built).not.toContain("fyers");
  });

  it("drops fyers from DATA_SOURCES in hub mode (putting the hub first), with a warning", () => {
    const { built, factories } = registry();
    const warnings: string[] = [];
    expect(ids(selectSources({ hub: true, dataSources: "fyers,eod", factories, warn: (message) => warnings.push(message) }))).toEqual(["hub", "eod"]);
    expect(built).not.toContain("fyers");
    expect(warnings[0]).toMatch(/fyers.*ignored/);
    expect(ids(selectSources({ hub: true, dataSources: "eod, HUB ,sample", factories }))).toEqual(["eod", "hub", "sample"]);
  });

  it("leaves out hub without its settings, and unknown ids", () => {
    const { factories } = registry();
    const warnings: string[] = [];
    expect(ids(selectSources({ hub: false, dataSources: "hub,upstox,eod", factories, warn: (message) => warnings.push(message) }))).toEqual(["eod"]);
    expect(warnings).toHaveLength(2);
    expect(ids(selectSources({ hub: false, dataSources: "nothing", factories, warn: () => {} }))).toEqual(["fyers", "eod", "sample"]);
  });
});
