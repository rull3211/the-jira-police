import { describe, expect, it } from "vitest";

import type { Settings } from "../settings.ts";
import { shouldPost } from "../wiring.ts";
import { resolveSettings } from "./triage-once.ts";

/** A configuration that has been told to post — the dangerous starting point. */
const WRITE_ENABLED = {
  SKILL_NAME: "intake-triage",
  WRITE_BACK: "true",
} as unknown as Settings;

describe("resolveSettings", () => {
  it("refuses to post without --write, even when .env says otherwise", () => {
    // REGRESSION. This previously only *added* WRITE_BACK when the flag was
    // present, so `WRITE_BACK=true` in .env — the ordinary state once the
    // daemon is live — meant a bare `triage:once SSX-1234` commented on a
    // shared production ticket. The flag whose whole purpose is to make that
    // deliberate was decorative in the only case where it mattered.
    const settings = resolveSettings(["SSX-3822"], WRITE_ENABLED);

    expect(settings.WRITE_BACK).toBe("false");
    expect(shouldPost(settings)).toBe(false);
  });

  it("posts when --write is passed", () => {
    expect(shouldPost(resolveSettings(["SSX-3822", "--write"], WRITE_ENABLED))).toBe(true);
  });

  it("stays off when neither the flag nor the setting asks for it", () => {
    const base = { ...WRITE_ENABLED, WRITE_BACK: "false" } as Settings;

    expect(shouldPost(resolveSettings(["SSX-3822"], base))).toBe(false);
  });

  it("keeps a stand-in skill in preview no matter what the flag says", () => {
    // Belt and braces: `shouldPost` pins the stand-ins to preview on its own,
    // because a rehearsal that comments on a real ticket is not a rehearsal.
    const base = { ...WRITE_ENABLED, SKILL_NAME: "mock-triage" } as Settings;

    expect(shouldPost(resolveSettings(["SSX-3822", "--write"], base))).toBe(false);
  });

  it("passes --skill through", () => {
    expect(
      resolveSettings(["SSX-1", "--skill", "live-triage-probe"], WRITE_ENABLED).SKILL_NAME,
    ).toBe("live-triage-probe");
  });

  it("leaves the configured skill alone when --skill is absent", () => {
    expect(resolveSettings(["SSX-1"], WRITE_ENABLED).SKILL_NAME).toBe("intake-triage");
  });
});
