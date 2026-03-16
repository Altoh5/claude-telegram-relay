#!/usr/bin/env bun
/**
 * Benchmark: Supabase REST API vs Convex HTTP Client
 *
 * Times the 4 key DB operations that happen per incoming Telegram message:
 *   1. Read recent messages (getRecentMessages)
 *   2. Read memory/facts (getFacts)
 *   3. Write a message (saveMessage)
 *   4. Read active goals (getActiveGoals)
 *
 * Each operation is run N times (default 5) and we report min, avg, max, p50.
 */

// Load env vars using the project's own loader (no dotenv dependency)
import { loadEnv } from "../src/lib/env";
import { join } from "path";
const PROJECT_ROOT = join(import.meta.dir, "..");
await loadEnv(join(PROJECT_ROOT, ".env"));

import { createClient } from "@supabase/supabase-js";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RUNS = 5;
const CHAT_ID = process.env.TELEGRAM_USER_ID || "benchmark-test";

// ---------------------------------------------------------------------------
// Supabase Setup
// ---------------------------------------------------------------------------

const sbUrl = process.env.SUPABASE_URL!;
const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
const sb = createClient(sbUrl, sbKey);

// ---------------------------------------------------------------------------
// Convex Setup
// ---------------------------------------------------------------------------

const convexUrl = process.env.CONVEX_URL!;
const cx = new ConvexHttpClient(convexUrl);

// ---------------------------------------------------------------------------
// Timing Helpers
// ---------------------------------------------------------------------------

interface TimingResult {
  times: number[];
  min: number;
  max: number;
  avg: number;
  p50: number;
}

async function timeOperation(
  name: string,
  fn: () => Promise<any>,
  runs: number = RUNS
): Promise<TimingResult> {
  const times: number[] = [];

  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;
    times.push(elapsed);
  }

  const sorted = [...times].sort((a, b) => a - b);
  return {
    times,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    p50: sorted[Math.floor(sorted.length / 2)],
  };
}

function fmtMs(ms: number): string {
  return ms.toFixed(1) + "ms";
}

// ---------------------------------------------------------------------------
// Supabase Operations
// ---------------------------------------------------------------------------

async function sbReadRecentMessages() {
  const { data, error } = await sb
    .from("messages")
    .select("*")
    .eq("chat_id", CHAT_ID)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Supabase read messages error: ${error.message}`);
  return data;
}

async function sbReadFacts() {
  const { data, error } = await sb
    .from("memory")
    .select("*")
    .eq("type", "fact")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Supabase read facts error: ${error.message}`);
  return data;
}

async function sbWriteMessage() {
  const { error } = await sb.from("messages").insert({
    chat_id: CHAT_ID,
    role: "user",
    content: `[benchmark] test message ${Date.now()}`,
    metadata: { benchmark: true },
  });
  if (error) throw new Error(`Supabase write message error: ${error.message}`);
  return true;
}

async function sbReadGoals() {
  const { data, error } = await sb
    .from("memory")
    .select("*")
    .eq("type", "goal")
    .is("completed_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Supabase read goals error: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Convex Operations
// ---------------------------------------------------------------------------

async function cxReadRecentMessages() {
  return await cx.query(api.messages.getRecent, {
    chat_id: CHAT_ID,
    limit: 20,
  });
}

async function cxReadFacts() {
  return await cx.query(api.memory.getByType, {
    type: "fact" as const,
  });
}

async function cxWriteMessage() {
  return await cx.mutation(api.messages.insert, {
    chat_id: CHAT_ID,
    role: "user",
    content: `[benchmark] test message ${Date.now()}`,
    metadata: { benchmark: true },
  });
}

async function cxReadGoals() {
  const docs = await cx.query(api.memory.getByType, {
    type: "goal" as const,
  });
  // Filter active goals (matching the app logic)
  return docs.filter((d: any) => !d.completed_at);
}

// ---------------------------------------------------------------------------
// Run Benchmark
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(72));
  console.log("  DB Benchmark: Supabase REST API vs Convex HTTP Client");
  console.log("=".repeat(72));
  console.log(`  Runs per operation: ${RUNS}`);
  console.log(`  Chat ID: ${CHAT_ID}`);
  console.log(`  Supabase URL: ${sbUrl}`);
  console.log(`  Convex URL: ${convexUrl}`);
  console.log("");

  // Warmup: one call to each backend to establish connections
  console.log("Warming up connections...");
  try {
    await sbReadRecentMessages();
    console.log("  Supabase: OK");
  } catch (e: any) {
    console.error("  Supabase warmup FAILED:", e.message);
    process.exit(1);
  }

  try {
    await cxReadRecentMessages();
    console.log("  Convex: OK");
  } catch (e: any) {
    console.error("  Convex warmup FAILED:", e.message);
    process.exit(1);
  }
  console.log("");

  // ---------------------------------------------------------------------------
  // Benchmark each operation
  // ---------------------------------------------------------------------------

  interface BenchResult {
    operation: string;
    supabase: TimingResult;
    convex: TimingResult;
  }

  const results: BenchResult[] = [];

  const operations: { name: string; sbFn: () => Promise<any>; cxFn: () => Promise<any> }[] = [
    { name: "Read recent messages (20)", sbFn: sbReadRecentMessages, cxFn: cxReadRecentMessages },
    { name: "Read memory/facts",         sbFn: sbReadFacts,          cxFn: cxReadFacts },
    { name: "Write a message (INSERT)",  sbFn: sbWriteMessage,       cxFn: cxWriteMessage },
    { name: "Read active goals",         sbFn: sbReadGoals,          cxFn: cxReadGoals },
  ];

  for (const op of operations) {
    process.stdout.write(`Benchmarking: ${op.name}...`);

    // Run Supabase first, then Convex (interleaved would add noise)
    const sbResult = await timeOperation(op.name, op.sbFn);
    const cxResult = await timeOperation(op.name, op.cxFn);

    results.push({ operation: op.name, supabase: sbResult, convex: cxResult });
    console.log(" done");
  }

  // ---------------------------------------------------------------------------
  // Clean up benchmark messages
  // ---------------------------------------------------------------------------

  console.log("\nCleaning up benchmark messages...");
  const { data: benchMsgs } = await sb
    .from("messages")
    .select("id")
    .eq("chat_id", CHAT_ID)
    .like("content", "[benchmark]%");
  if (benchMsgs && benchMsgs.length > 0) {
    const ids = benchMsgs.map((m: any) => m.id);
    await sb.from("messages").delete().in("id", ids);
    console.log(`  Deleted ${ids.length} Supabase benchmark messages`);
  }
  // Note: Convex benchmark messages are left for now (no bulk delete in HTTP client)

  // ---------------------------------------------------------------------------
  // Print results table
  // ---------------------------------------------------------------------------

  console.log("\n" + "=".repeat(72));
  console.log("  RESULTS (all times in milliseconds)");
  console.log("=".repeat(72));

  // Header
  console.log(
    "\n" +
    padRight("Operation", 32) +
    padRight("Backend", 10) +
    padRight("Min", 10) +
    padRight("Avg", 10) +
    padRight("P50", 10) +
    padRight("Max", 10)
  );
  console.log("-".repeat(82));

  for (const r of results) {
    // Supabase row
    console.log(
      padRight(r.operation, 32) +
      padRight("Supabase", 10) +
      padRight(fmtMs(r.supabase.min), 10) +
      padRight(fmtMs(r.supabase.avg), 10) +
      padRight(fmtMs(r.supabase.p50), 10) +
      padRight(fmtMs(r.supabase.max), 10)
    );
    // Convex row
    console.log(
      padRight("", 32) +
      padRight("Convex", 10) +
      padRight(fmtMs(r.convex.min), 10) +
      padRight(fmtMs(r.convex.avg), 10) +
      padRight(fmtMs(r.convex.p50), 10) +
      padRight(fmtMs(r.convex.max), 10)
    );

    // Speedup
    const speedup = r.supabase.avg / r.convex.avg;
    const winner = speedup > 1 ? "Convex" : "Supabase";
    const factor = speedup > 1 ? speedup : 1 / speedup;
    console.log(
      padRight("", 32) +
      `--> ${winner} is ${factor.toFixed(2)}x faster (avg)`
    );
    console.log("-".repeat(82));
  }

  // ---------------------------------------------------------------------------
  // Overall summary
  // ---------------------------------------------------------------------------

  const sbTotalAvg = results.reduce((sum, r) => sum + r.supabase.avg, 0);
  const cxTotalAvg = results.reduce((sum, r) => sum + r.convex.avg, 0);

  console.log("\n" + "=".repeat(72));
  console.log("  COMBINED (all 4 operations per message cycle)");
  console.log("=".repeat(72));
  console.log(`  Supabase total avg: ${fmtMs(sbTotalAvg)}`);
  console.log(`  Convex total avg:   ${fmtMs(cxTotalAvg)}`);

  const overallSpeedup = sbTotalAvg / cxTotalAvg;
  const overallWinner = overallSpeedup > 1 ? "Convex" : "Supabase";
  const overallFactor = overallSpeedup > 1 ? overallSpeedup : 1 / overallSpeedup;
  console.log(`  --> ${overallWinner} is ${overallFactor.toFixed(2)}x faster overall`);
  console.log("");

  // ---------------------------------------------------------------------------
  // Individual run details
  // ---------------------------------------------------------------------------

  console.log("=".repeat(72));
  console.log("  INDIVIDUAL RUN DETAILS");
  console.log("=".repeat(72));

  for (const r of results) {
    console.log(`\n  ${r.operation}:`);
    console.log(`    Supabase: [${r.supabase.times.map(fmtMs).join(", ")}]`);
    console.log(`    Convex:   [${r.convex.times.map(fmtMs).join(", ")}]`);
  }

  console.log("");
}

function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
