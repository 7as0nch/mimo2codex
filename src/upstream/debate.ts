import type { ChatMessage, ChatRequest, ChatResponse } from "../translate/types.js";
import type { ProviderRuntime } from "../providers/types.js";
import { callOpenAICompat } from "./openaiCompatClient.js";
import { log } from "../util/log.js";

// ---------------------------------------------------------------------------
// Debate runner — "Super Mode"
//
// Three participants:
//   Debater 1 (proposer)  — analyzes the task, proposes an execution plan
//   Debater 2 (challenger) — critiques and refines the proposal
//   Arbitrator (judge)     — after each round of both debaters speaking,
//                            reads their outputs and decides whether they
//                            have reached genuine consensus
//
// The debate has no round limit. It ends when:
//   - The Arbitrator judges that consensus has been reached
//   - The client disconnects (signal.aborted)
//   - Safety cap (100 rounds) is hit (practically unreachable)
//
// Only the Arbitrator's final consensus enters the executor's context.
// The full debate transcript is excluded from the executor to save tokens.
// ---------------------------------------------------------------------------

export interface DebateConfig {
  runtime: ProviderRuntime;
  upstreamModel: string;
  userAgent: string;
  maxTokensPerTurn?: number;
  /** Max tokens for the arbitrator's judgment. Default: 1024. */
  arbitratorMaxTokens?: number;
}

export interface DebateResult {
  /** Final consensus text to inject into the executor's context. */
  consensus: string;
  /** Full transcript for logging / debugging. */
  transcript: DebateTurn[];
  /** Number of rounds actually executed. */
  rounds: number;
  /** Whether the arbitrator judged that consensus was reached. */
  agreed: boolean;
}

export interface DebateTurn {
  round: number;
  role: "debater1" | "debater2";
  content: string;
}

// ─── System prompts ────────────────────────────────────────────────────────

const DEBATER1_SYSTEM = [
  "You are Debater 1 (Mimo-v2.5-pro1) in a strategy debate.",
  "Your job: analyze the user's task and propose the best approach for executing it.",
  "Focus on: what tools to call, what files to read/write, what commands to run, and in what order.",
  "Be specific and actionable — your proposal will be used by an executor agent.",
  "Keep responses concise and structured (bullet points preferred).",
  "",
  "IMPORTANT: At the end of your message, output a JSON block on its own line:",
  "```json",
  '{"consensus": false, "text": "<your current best proposal summary>"}',
  "```",
  'Set "consensus" to true ONLY when you fully agree with the other debater\'s latest proposal and believe the plan is ready for execution.',
].join("\n");

const DEBATER2_SYSTEM = [
  "You are Debater 2 (Mimo-v2.5-pro2) in a strategy debate.",
  "Your job: critically evaluate Debater 1's proposals and suggest improvements or alternatives.",
  "Challenge assumptions, identify risks, and propose better approaches when warranted.",
  "Be specific and actionable — your feedback will shape the final execution plan.",
  "Keep responses concise and structured (bullet points preferred).",
  "",
  "IMPORTANT: At the end of your message, output a JSON block on its own line:",
  "```json",
  '{"consensus": false, "text": "<your refined proposal or counter-proposal>"}',
  "```",
  'Set "consensus" to true ONLY when you fully agree with Debater 1\'s latest proposal and believe the plan is ready for execution.',
].join("\n");

const ARBITRATOR_SYSTEM = [
  "You are the Arbitrator (Mimo-v2.5-pro3) in a strategy debate.",
  "Your job: judge whether two debaters have reached genuine consensus on an execution plan.",
  "",
  "After reading both debaters' latest outputs, you must decide:",
  '  - "consensus": true  — their positions have converged into a coherent, actionable plan',
  '  - "consensus": false — they still disagree on important details, the debate must continue',
  "",
  "Evaluate objectively:",
  "  - Are the proposed steps compatible, not contradictory?",
  "  - Do both debaters agree on the key decisions (which tools, which files, which approach)?",
  "  - Is the plan specific enough for an executor to act on without ambiguity?",
  "",
  'If consensus is true, your "summary" field MUST contain the unified execution plan,',
  "combining the best elements of both debaters' positions into a single actionable strategy.",
  'If consensus is false, your "summary" field should briefly note the remaining disagreement.',
  "",
  "Be decisive. Do not prolong the debate unnecessarily — if the proposals are broadly",
  "compatible and the disagreement is minor, declare consensus and merge them.",
  "",
  "Output exactly one JSON block:",
  "```json",
  '{"consensus": true_or_false, "summary": "<unified plan or remaining disagreement>"}',
  "```",
].join("\n");

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the last ```json ... ``` block from a message.
 */
function extractJsonBlock<T>(content: string): T | null {
  const regex = /```json\s*\n?([\s\S]*?)\n?\s*```/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;
  try {
    return JSON.parse(lastMatch[1].trim()) as T;
  } catch {
    return null;
  }
}

interface ArbitratorJudgment {
  consensus: boolean;
  summary: string;
}

/**
 * Ask the Arbitrator whether the debate has reached consensus.
 * Reads the latest outputs from both debaters.
 */
async function askArbitrator(
  round: number,
  d1Latest: string,
  d2Latest: string,
  cfg: DebateConfig,
  signal: AbortSignal,
): Promise<ArbitratorJudgment> {
  const maxTokens = cfg.arbitratorMaxTokens ?? 1024;

  const prompt = [
    "Round " + round + " of the debate has concluded.",
    "",
    "--- Debater 1 (Mimo-v2.5-pro1) latest output ---",
    d1Latest,
    "",
    "--- Debater 2 (Mimo-v2.5-pro2) latest output ---",
    d2Latest,
    "",
    "Judge whether these two positions have converged into a coherent execution plan.",
  ].join("\n");

  const body: ChatRequest = {
    model: cfg.upstreamModel,
    messages: [
      { role: "system", content: ARBITRATOR_SYSTEM },
      { role: "user", content: prompt },
    ],
    stream: false,
    max_completion_tokens: maxTokens,
  };

  log.info("debate round " + round + ": arbitrator judging...");
  const res = await callOpenAICompat(
    {
      baseUrl: cfg.runtime.baseUrl,
      apiKey: cfg.runtime.apiKey,
      userAgent: cfg.userAgent,
      contextOverflowMode: "passthrough",
      maxRetries: 1,
    },
    body,
    signal,
  );
  const json = (await res.json()) as ChatResponse;
  const content = json.choices?.[0]?.message?.content ?? "";

  const parsed = extractJsonBlock<ArbitratorJudgment>(content);
  if (parsed && typeof parsed.consensus === "boolean") {
    log.info("debate round " + round + ": arbitrator judgment", {
      consensus: parsed.consensus,
      summaryLen: (parsed.summary ?? "").length,
    });
    return parsed;
  }

  // Fallback: if the arbitrator didn't output valid JSON, treat as no consensus.
  log.warn("debate round " + round + ": arbitrator returned unparseable output, treating as no consensus", {
    preview: content.slice(0, 200),
  });
  return { consensus: false, summary: "(arbitrator output unparseable)" };
}

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * Run a debate between two model instances on the given user task.
 * An arbitrator judges after each round whether consensus has been reached.
 */
export async function runDebate(
  taskSummary: string,
  cfg: DebateConfig,
  signal: AbortSignal,
): Promise<DebateResult> {
  const maxTokens = cfg.maxTokensPerTurn ?? 2048;
  const SAFETY_CAP = 100;

  const transcript: DebateTurn[] = [];
  const debateHistory1: ChatMessage[] = [];
  const debateHistory2: ChatMessage[] = [];

  let agreed = false;
  let finalConsensus = "";

  for (let round = 1; round <= SAFETY_CAP; round++) {
    if (signal.aborted) break;

    // ── Debater 1 speaks ──
    const d1Prompt = round === 1
      ? "The user wants to accomplish the following task. Propose the best execution plan.\n\n---\n" + taskSummary + "\n---"
      : "Here is Debater 2's latest feedback. Refine your plan or express agreement.\n\n---\n" + debateHistory2[debateHistory2.length - 1].content + "\n---";

    debateHistory1.push({ role: "user", content: d1Prompt });

    log.info("debate round " + round + ": debater 1 thinking...");
    const d1Res = await callOpenAICompat(
      {
        baseUrl: cfg.runtime.baseUrl,
        apiKey: cfg.runtime.apiKey,
        userAgent: cfg.userAgent,
        contextOverflowMode: "passthrough",
        maxRetries: 1,
      },
      {
        model: cfg.upstreamModel,
        messages: [{ role: "system", content: DEBATER1_SYSTEM }, ...debateHistory1],
        stream: false,
        max_completion_tokens: maxTokens,
      },
      signal,
    );
    const d1Json = (await d1Res.json()) as ChatResponse;
    const d1Content = d1Json.choices?.[0]?.message?.content ?? "";
    debateHistory1.push({ role: "assistant", content: d1Content });
    transcript.push({ round, role: "debater1", content: d1Content });
    log.info("debate round " + round + ": debater 1 done", { contentLen: d1Content.length });

    // ── Debater 2 responds ──
    const d2Prompt = round === 1
      ? "Here is Debater 1's proposed execution plan. Critique it and suggest improvements.\n\n---\n" + d1Content + "\n---"
      : "Here is Debater 1's latest response. Evaluate if you now agree, or continue refining.\n\n---\n" + d1Content + "\n---";

    debateHistory2.push({ role: "user", content: d2Prompt });

    log.info("debate round " + round + ": debater 2 thinking...");
    const d2Res = await callOpenAICompat(
      {
        baseUrl: cfg.runtime.baseUrl,
        apiKey: cfg.runtime.apiKey,
        userAgent: cfg.userAgent,
        contextOverflowMode: "passthrough",
        maxRetries: 1,
      },
      {
        model: cfg.upstreamModel,
        messages: [{ role: "system", content: DEBATER2_SYSTEM }, ...debateHistory2],
        stream: false,
        max_completion_tokens: maxTokens,
      },
      signal,
    );
    const d2Json = (await d2Res.json()) as ChatResponse;
    const d2Content = d2Json.choices?.[0]?.message?.content ?? "";
    debateHistory2.push({ role: "assistant", content: d2Content });
    transcript.push({ round, role: "debater2", content: d2Content });
    log.info("debate round " + round + ": debater 2 done", { contentLen: d2Content.length });

    // ── Arbitrator judges ──
    const judgment = await askArbitrator(round, d1Content, d2Content, cfg, signal);

    if (judgment.consensus) {
      agreed = true;
      finalConsensus = judgment.summary || buildConsensusSummary(transcript);
      log.info("debate: arbitrator declared consensus after round " + round);
      break;
    }

    log.info("debate round " + round + ": no consensus yet", {
      reason: judgment.summary?.slice(0, 200),
    });
  }

  if (!agreed) {
    finalConsensus = buildConsensusSummary(transcript);
    log.info("debate: safety cap (" + SAFETY_CAP + ") reached without consensus, using best-effort summary");
  }

  return {
    consensus: finalConsensus,
    transcript,
    rounds: transcript.length > 0 ? transcript[transcript.length - 1].round : 0,
    agreed,
  };
}

/**
 * Fallback consensus builder — used when the arbitrator doesn't provide a
 * summary (e.g. safety cap reached).
 */
function buildConsensusSummary(transcript: DebateTurn[]): string {
  if (transcript.length === 0) return "";

  let lastD1 = "";
  let lastD2 = "";
  for (const t of transcript) {
    if (t.role === "debater1") lastD1 = t.content;
    if (t.role === "debater2") lastD2 = t.content;
  }

  const d1Parsed = extractJsonBlock<{ consensus?: boolean; text?: string }>(lastD1);
  const d2Parsed = extractJsonBlock<{ consensus?: boolean; text?: string }>(lastD2);

  const parts: string[] = [
    "[Debate consensus — use this as your execution strategy]",
    "",
    "Debater 1 final position: " + (d1Parsed?.text ?? "(no structured proposal)"),
    "Debater 2 final position: " + (d2Parsed?.text ?? "(no structured proposal)"),
    "",
    "Execute the agreed-upon plan above. If there are remaining disagreements, combine the best elements of both proposals.",
  ];

  return parts.join("\n");
}