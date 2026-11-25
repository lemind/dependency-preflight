// Rules-only local run of miner 7314's pipeline: no model, no wallet, nothing paid.
// Run from /home/dl/_prog/telegraph-pr-agent/miner (for its node_modules): NODE_USE_ENV_PROXY=1 npx tsx <this file> "What changed in X from A to B?"
// That checkout must be on a recent main (miner p10). Free: no model, no wallet.
import { answerQuestion } from "/home/dl/_prog/telegraph-pr-agent/miner/src/answer.ts";
import { MemoryStore } from "/home/dl/_prog/telegraph-pr-agent/miner/src/cache.ts";
const query = process.argv[2];
const started = Date.now();
const { answer } = await answerQuestion(query, { store: new MemoryStore(), env: {}, caller: null });
const a = answer as any;
console.log(`Q: ${query}\noutcome ${a.outcome}, ${(Date.now() - started) / 1000}s`);
console.log((a.answer ?? "").split("\n").slice(0, 14).join("\n"));
