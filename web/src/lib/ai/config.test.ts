import { describe, expect, it } from "vitest";

import { isAiConfigured, loadAiConfig } from "./config";

describe("loadAiConfig", () => {
  it("defaults to noop when unset", () => {
    const cfg = loadAiConfig({});
    expect(cfg.provider).toBe("noop");
    expect(isAiConfigured(cfg)).toBe(false);
  });

  it("treats incomplete openai_compatible as noop", () => {
    const cfg = loadAiConfig({
      AI_PROVIDER: "openai_compatible",
      AI_BASE_URL: "https://api.example.com/v1",
      // missing key + model
    });
    expect(cfg.provider).toBe("noop");
    expect(isAiConfigured(cfg)).toBe(false);
  });

  it("loads openai_compatible when complete", () => {
    const cfg = loadAiConfig({
      AI_PROVIDER: "openai_compatible",
      AI_BASE_URL: "https://api.groq.com/openai/v1/",
      AI_API_KEY: "gsk_test",
      AI_MODEL: "llama-3.1-8b-instant",
      AI_TIMEOUT_MS: "45000",
    });
    expect(cfg.provider).toBe("openai_compatible");
    expect(cfg.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKey).toBe("gsk_test");
    expect(cfg.model).toBe("llama-3.1-8b-instant");
    expect(cfg.timeoutMs).toBe(45_000);
    expect(isAiConfigured(cfg)).toBe(true);
  });
});
