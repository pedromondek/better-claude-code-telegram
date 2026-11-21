import type { CdpPage } from "../../cdp.ts";

export type CdpResult = Record<string, unknown>;

export interface FakeCdpPage extends CdpPage {
  calls: [string, CdpResult | undefined][];
  evaluated: () => string[];
}

export function fakeCdpPage(
  answer: (method: string, params: CdpResult) => CdpResult = () => ({}),
): FakeCdpPage {
  const calls: FakeCdpPage["calls"] = [];

  return {
    calls,
    evaluated: (): string[] =>
      calls
        .filter(([method]) => method === "Runtime.evaluate")
        .map(([, params]) => String(params?.expression)),
    send: (method, params): Promise<CdpResult> => {
      calls.push([method, params]);

      return Promise.resolve(answer(method, params ?? {}));
    },
    once: (event): Promise<CdpResult> => {
      calls.push([`once ${event}`, undefined]);

      return Promise.resolve({});
    },
  };
}

export function evaluatedValue(value: unknown): CdpResult {
  return { result: { type: "object", value } };
}
