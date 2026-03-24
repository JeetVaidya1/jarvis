/**
 * Local ML sentiment analysis for trading edge.
 *
 * Uses @huggingface/transformers (ONNX, in-process) with DistilBERT SST-2.
 * ~30ms inference, M-chip WASM/ONNX path. No server, no API call.
 *
 * Used by the forecaster as a pre-signal before the full LLM pass.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { pipeline } from "@huggingface/transformers";
import { createLogger } from "../logger.js";

const log = createLogger("sentiment");

// Lazy-loaded singleton — model downloads once (~25MB), then stays in memory
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sentimentPipeline: any | null = null;

export interface SentimentResult {
  label: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
  /** Confidence score 0-1 for the predicted label */
  score: number;
  /** Net sentiment: positive → +1, negative → -1, scaled by confidence */
  signal: number;
}

async function getPipeline(): Promise<NonNullable<typeof sentimentPipeline>> {
  if (!sentimentPipeline) {
    log.info("Loading sentiment model (first run — downloads ~25MB)...");
    sentimentPipeline = await pipeline(
      "sentiment-analysis",
      "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
      { dtype: "fp32" },
    );
    log.info("Sentiment model ready.");
  }
  return sentimentPipeline;
}

/**
 * Classify the sentiment of a market question or news text.
 * Returns a signal in [-1, +1]: positive = bullish/yes-biased, negative = bearish/no-biased.
 */
export async function classifySentiment(text: string): Promise<SentimentResult> {
  try {
    const model = await getPipeline();
    const input = text.slice(0, 512); // BERT max context
    const raw = await model(input);

    const result = Array.isArray(raw) ? raw[0] : raw;
    const label = (result?.label ?? "NEUTRAL") as string;
    const score = typeof result?.score === "number" ? result.score : 0.5;

    const normalizedLabel =
      label.toUpperCase() === "POSITIVE"
        ? "POSITIVE"
        : label.toUpperCase() === "NEGATIVE"
          ? "NEGATIVE"
          : "NEUTRAL";

    const signal =
      normalizedLabel === "POSITIVE"
        ? score
        : normalizedLabel === "NEGATIVE"
          ? -score
          : 0;

    return { label: normalizedLabel, score, signal };
  } catch (err) {
    log.warn(`Sentiment inference failed: ${err}`);
    return { label: "NEUTRAL", score: 0.5, signal: 0 };
  }
}

/**
 * Format sentiment result as a one-line string for injection into forecaster prompts.
 */
export function formatSentimentSignal(result: SentimentResult): string {
  const direction =
    result.label === "POSITIVE"
      ? "bullish / YES-leaning"
      : result.label === "NEGATIVE"
        ? "bearish / NO-leaning"
        : "neutral";
  return `LOCAL SENTIMENT SIGNAL: ${result.label} (${(result.score * 100).toFixed(0)}% confidence) — ${direction}. Signal: ${result.signal > 0 ? "+" : ""}${result.signal.toFixed(2)} (range -1 to +1).`;
}
