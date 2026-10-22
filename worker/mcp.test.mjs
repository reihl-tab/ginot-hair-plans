import test from "node:test";
import assert from "node:assert/strict";
import { callTool, rpc, handleRequest } from "./mcp.mjs";

const data = { generated: "2026-10-22", rows: [
  { pl_number: "A-1", pl_name: "Alpha", station_desc: "הפקדה להתנגדויות", objection_deadline_derived_60d_from_publication: "2026-11-05", private_note: "SECRET" },
  { pl_number: "B-2", pl_name: "Beta", station_desc: "אישור", objection_deadline_derived_60d_from_publication: "2026-11-06" },
  { pl_number: "C-3", pl_name: "Gamma", station_desc: "הפקדה", objection_deadline_derived_60d_from_publication: "bad" },
] };
const post = (body) => new Request("https://x/mcp", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const fake = async () => new Response(JSON.stringify(data));

test("only public fields exposed", () => {
  const r = callTool(data, "search_plans", { query: "alpha" });
  assert.equal(r.total_matches, 1);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.throws(() => callTool(data, "get_plan", { pl_number: "zz" }), /not found/);
});

test("Hebrew folding: exact ranks before folded, phrase queries still match, fold:false and non-foldable tokens", () => {
  const plans = { rows: [
    { pl_number: "H-1", pl_name: "שכונת בני בתירא" },
    { pl_number: "H-2", pl_name: "התחדשות עירונית רמת גן" },
    { pl_number: "H-3", pl_name: "בית ילדים חדש" },
    { pl_number: "H-4", pl_name: "גן ילד קטן" },
    { pl_number: "H-5", pl_name: "עוגנים בנמל" },
  ] };
  // Two-word exact phrase still finds exactly one plan (bag-of-tokens, not substring).
  const phrase = callTool(plans, "search_plans", { query: "בני בתירא" });
  assert.equal(phrase.total_matches, 1);
  assert.equal(phrase.plans[0].pl_number, "H-1");
  assert.equal(phrase.plans[0].match, "exact");

  const urban = callTool(plans, "search_plans", { query: "התחדשות עירונית" });
  assert.equal(urban.total_matches, 1);
  assert.equal(urban.plans[0].pl_number, "H-2");

  // "גני" (3 letters, no foldable prefix/suffix) must NOT exact- or fold-match
  // "עוגנים" (folds to "עוגן", not "גני") - it only surfaces as a low-confidence
  // partial (substring) hit, the old pre-folding search's own behavior for this
  // exact case ("גני" is literally contained in "עוגנים").
  const noWholeTokenMatch = callTool(plans, "search_plans", { query: "גני" });
  assert.equal(noWholeTokenMatch.total_matches, 1);
  assert.equal(noWholeTokenMatch.plans[0].match, "partial");
  assert.equal(noWholeTokenMatch.plans[0].pl_number, "H-5");

  // Singular query folds to match a plural token, and ranks after the exact hit.
  const folded = callTool(plans, "search_plans", { query: "ילד" });
  assert.equal(folded.total_matches, 2);
  assert.equal(folded.plans[0].pl_number, "H-4");
  assert.equal(folded.plans[0].match, "exact");
  assert.equal(folded.plans[1].pl_number, "H-3");
  assert.equal(folded.plans[1].match, "folded");
  assert.deepEqual(folded.plans[1].matched_as, ["ילדים"]);

  // fold:false skips the folded tier, but partial (substring) hits still fill in: "ילד"
  // is a substring of "ילדים", so H-3 still comes back, now ranked as "partial" behind
  // the exact hit rather than disappearing or counting as "folded".
  const exactOnly = callTool(plans, "search_plans", { query: "ילד", fold: false });
  assert.equal(exactOnly.total_matches, 2);
  assert.equal(exactOnly.plans[0].pl_number, "H-4");
  assert.equal(exactOnly.plans[0].match, "exact");
  assert.equal(exactOnly.plans[1].pl_number, "H-3");
  assert.equal(exactOnly.plans[1].match, "partial");

  // A token with digits/hyphen/Latin letters is never folded: it only matches itself.
  const planNumber = callTool({ rows: [{ pl_number: "101-1377753" }, { pl_number: "101-1377754" }] },
    "search_plans", { query: "101-1377753" });
  assert.equal(planNumber.total_matches, 1);
  assert.equal(planNumber.plans[0].pl_number, "101-1377753");
});

test("partial tier: old substring behavior as a fallback, superset of it, fold:false keeps it", () => {
  const plans = { rows: [
    { pl_number: "101-1348069", pl_name: "מתחם מגורים" },
    { pl_number: "101-9999999", pl_name: "שונה" },
    { pl_number: "H-10", pl_name: "גינון ציבורי" },
    { pl_number: "H-11", pl_name: "ילד קטן" },
  ] };

  // A plan-number query without its "101-" prefix: not a whole-token match (the row's
  // token is "101-1348069"), but it IS a substring of that token - the exact regression
  // Instinct found live ("1348069" 1 -> 0). Must come back as a partial hit.
  const byNumber = callTool(plans, "search_plans", { query: "1348069" });
  assert.equal(byNumber.total_matches, 1);
  assert.equal(byNumber.plans[0].pl_number, "101-1348069");
  assert.equal(byNumber.plans[0].match, "partial");
  assert.deepEqual(byNumber.plans[0].matched_as, ["1348069"]);

  // A partial word, substring of a longer unrelated token ("גינ" inside "גינון") -
  // the old substring search found this; whole-token exact/folded does not.
  const byPartialWord = callTool(plans, "search_plans", { query: "גינ" });
  assert.equal(byPartialWord.total_matches, 1);
  assert.equal(byPartialWord.plans[0].pl_number, "H-10");
  assert.equal(byPartialWord.plans[0].match, "partial");

  // Ranking: exact, then folded, then partial, each row in exactly one tier (no dupes).
  const ranked = callTool(plans, "search_plans", { query: "ילד" });
  assert.equal(ranked.total_matches, 1);
  assert.equal(ranked.plans[0].pl_number, "H-11");
  assert.equal(ranked.plans[0].match, "exact");

  // fold:false still keeps the partial tier (fold:false = exact whole-token + partial only).
  const noFold = callTool(plans, "search_plans", { query: "1348069", fold: false });
  assert.equal(noFold.total_matches, 1);
  assert.equal(noFold.plans[0].match, "partial");
});

test("partial tier: result set is always a superset of the old plain-substring search", () => {
  const oldSubstringSearch = (rows, q) => rows.filter((r) => ["pl_number", "pl_name", "station_desc", "entity_subtype_desc"]
    .map((k) => r[k] || "").join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const plans = { rows: [
    { pl_number: "H-1", pl_name: "שכונת בני בתירא" },
    { pl_number: "H-2", pl_name: "התחדשות עירונית רמת גן" },
    { pl_number: "H-3", pl_name: "בית ילדים חדש" },
    { pl_number: "H-4", pl_name: "גן ילד קטן" },
    { pl_number: "H-5", pl_name: "עוגנים בנמל" },
    { pl_number: "101-1348069", pl_name: "מתחם מגורים" },
  ] };
  for (const q of ["מלון", "גינ", "ילד", "1348069", "בנמל", "עוגנים"]) {
    const oldCount = oldSubstringSearch(plans.rows, q).length;
    const newCount = callTool(plans, "search_plans", { query: q }).total_matches;
    assert.ok(newCount >= oldCount, `query "${q}": new ${newCount} should be >= old ${oldCount}`);
  }
});

test("limit clamped", () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ pl_number: String(i) }));
  assert.equal(callTool({ rows }, "search_plans", { limit: 9999 }).plans.length, 50);
});

test("windows: deposit stage only, derived label, bad date rejected", () => {
  const r = callTool(data, "upcoming_objection_windows", { days: 30, as_of: "2026-10-22" });
  assert.deepEqual(r.plans.map((p) => p.pl_number), ["A-1"]);
  assert.equal(r.plans[0].days_left_derived, 14);
  assert.match(r.note, /not a verified official/);
  assert.throws(() => callTool(data, "upcoming_objection_windows", { as_of: "22/10/2026" }), /YYYY-MM-DD/);
});

test("protocol: init, list, unknown tool is error result, unknown method", () => {
  assert.deepEqual(rpc(data, { id: 1, method: "initialize" }).result.capabilities, { tools: {} });
  assert.equal(rpc(data, { method: "notifications/initialized" }), null);
  assert.equal(rpc(data, { id: 2, method: "tools/list" }).result.tools.length, 4);
  assert.equal(rpc(data, { id: 3, method: "tools/call", params: { name: "delete_all" } }).result.isError, true);
  assert.equal(rpc(data, { id: 4, method: "resources/write" }).error.code, -32601);
});

test("http: POST works, GET refused, garbage 400, upstream failure 502, batch cap", async () => {
  const ok = await handleRequest(post({ jsonrpc: "2.0", id: 1, method: "ping" }), fake);
  assert.deepEqual((await ok.json()).result, {});
  assert.equal((await handleRequest(new Request("https://x/mcp"), fake)).status, 405);
  assert.equal((await handleRequest(post("nope"), fake)).status, 400);
  assert.equal((await handleRequest(post({ id: 1, method: "ping" }), async () => new Response("", { status: 500 }))).status, 502);
  assert.equal((await handleRequest(post(Array(11).fill({ id: 1, method: "ping" })), fake)).status, 400);
  assert.equal((await handleRequest(post({ method: "notifications/initialized" }), fake)).status, 202);
});
