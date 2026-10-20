import "server-only";

import { loadAiConfig, type AiConfig } from "./config";
import type { AiCompleteRequest, AiProvider } from "./types";

class NoopProvider implements AiProvider {
  readonly id = "noop";
  readonly model = "";
  async complete(): Promise<string> {
    throw new AiNotConfiguredError();
  }
}

class OpenAiCompatibleProvider implements AiProvider {
  readonly id = "openai_compatible";
  constructor(
    private readonly cfg: AiConfig,
  ) {}
  get model() {
    return this.cfg.model;
  }
  async complete(req: AiCompleteRequest): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: req.system },
            {
              role: "user",
              content: `${req.user}\n\nRespond with JSON only. Shape: ${req.jsonSchemaHint}`,
            },
          ],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `AI provider HTTP ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || typeof content !== "string") {
        throw new Error("AI provider returned empty content");
      }
      return content;
    } finally {
      clearTimeout(t);
    }
  }
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI not configured");
    this.name = "AiNotConfiguredError";
  }
}

export function getAiProvider(cfg: AiConfig = loadAiConfig()): AiProvider {
  if (cfg.provider === "openai_compatible") {
    return new OpenAiCompatibleProvider(cfg);
  }
  return new NoopProvider();
}
