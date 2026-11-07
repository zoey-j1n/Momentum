// The one place that calls Claude. Structured output via output_config.format, then Zod again on the way out.
// Never call this inside a database transaction.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const EFFORT = (process.env.ANALYSIS_EFFORT ?? "medium") as "low" | "medium" | "high";
const MAX_TOKENS = Number(process.env.ANALYSIS_MAX_TOKENS ?? 16_384);

// USD per million tokens. Update when pricing changes; the eval in Milestone 8 reads costUsd from Analysis rows.
const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

// Reads ANTHROPIC_API_KEY from the environment. timeout is milliseconds in the TS SDK.
// maxRetries covers 429/5xx/connection errors with the SDK's own backoff.
const client = new Anthropic({ timeout: 60_000, maxRetries: 2 });

/** Thrown when the model's answer can't be used. `retryable` tells the job runner whether another attempt could help. */
export class ModelOutputError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export type ModelCall<T> = {
  output: T;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  raw: unknown; // the parsed JSON exactly as returned, for Analysis.rawOutput
};

/**
 * One structured call. `system` is the instructions, `user` is the <thread> payload, `schema` is the Zod shape
 * the response must match. The API constrains the output to the schema; we validate again anyway, because
 * a refusal or a max_tokens cutoff can still produce something that is not a complete object.
 */
export async function callClaude<T>(args: { system: string; user: string; schema: z.ZodType<T> }): Promise<ModelCall<T>> {
  const started = Date.now();

  const request = () => client.messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: { format: zodOutputFormat(args.schema), effort: EFFORT },
    });
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request();
  } catch (err) {
    // The SDK throws before we can look at stop_reason when the JSON is truncated (max_tokens) or malformed.
    // Treat it like a cutoff: not retryable at the same cap, and the analysis records the reason.
    if (err instanceof Error && /parse structured output/i.test(err.message)) {
      throw new ModelOutputError(`output could not be parsed, probably cut off at ${MAX_TOKENS} tokens: ${err.message.slice(0, 120)}`, false);
    }
    throw err;
  }

  const latencyMs = Date.now() - started;

  // Both of these are failures, per CLAUDE.md. A refusal will not succeed on retry; a cutoff might not either
  // at the same max_tokens, so the job runner should fail the analysis rather than loop.
  if (response.stop_reason === "refusal") {
    throw new ModelOutputError(`model refused (${response.stop_details?.category ?? "no category"})`, false);
  }
  if (response.stop_reason === "max_tokens") {
    throw new ModelOutputError(`output cut off at ${MAX_TOKENS} tokens`, false);
  }

  // parse() already validated against the Zod schema; parsed_output is null if that failed.
  // We run it once more explicitly so the rule "validate all model output with Zod" is visible here.
  const check = args.schema.safeParse(response.parsed_output);
  if (!check.success) {
    throw new ModelOutputError(`output did not match schema: ${check.error.message}`, true);
  }

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const price = PRICE_PER_MTOK[response.model] ?? PRICE_PER_MTOK[MODEL] ?? { input: 0, output: 0 };
  const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;

  return { output: check.data, model: response.model, latencyMs, inputTokens, outputTokens, costUsd, raw: response.parsed_output };
}
