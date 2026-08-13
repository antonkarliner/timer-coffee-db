// Phase 0 (plans/016-publish-gate-correction.md) §6 exit criterion 3 —
// expectations manifest.
//
// Maps each cached capture id to what it should do once the plan's phases
// have landed, so criterion 3 ("Offline replay over the existing 015
// captures shows: ... flip blocked<->publishable ... every PASS/control ->
// unchanged") becomes one command (`replay.ts --all`) instead of a manual
// cross-reference against plans/015 and plans/016 §6 every time.
//
// Taken from plans/016 §6 criterion 3 and plans/015-live-test-observations-
// 2026-08-12.md's per-capture table. Where a capture's expectation is
// genuinely unclear from those two documents, it is marked "unknown" rather
// than guessed — see plans/HANDOFF §7: "Say 'unknown' rather than filling
// the gap."
//
// IMPORTANT SCOPE NOTE: this harness only replays provenance.ts
// (verifyAmountProvenance/verifyTimingProvenance). It does NOT run
// parser.ts's full finalizeDraftResponse publish gate.
//
// CONFIRMED BY READING parser.ts DIRECTLY (2026-08-12, during this fidelity
// fix — the file was being concurrently edited by other agents in this
// session and had moved well past what plans/016 §4 describes as
// outstanding): as of the code on disk right now,
//   - Phase 1a (unit lexicon incl. Arabic/Persian words, empty-rendered-
//     unit compatibility) — LANDED IN provenance.ts. This harness DOES
//     exercise it, because it calls verifyAmountProvenance directly.
//   - Phase 2 (verify-mode wording, `normalizeStepDescriptionTemplate`'s
//     `args.mode === "verify"` branch) — LANDED IN parser.ts. Outside
//     provenance.ts entirely; irrelevant to amount/timing findings either
//     way.
//   - Phase 3a (D4 range-collapse, `findRangeEndpointCollapseIssues`) —
//     LANDED IN parser.ts (finalizeDraftResponse, parser.ts ~5978-5990),
//     called with `foldRemappedExtractedAmounts` and `renderedAmounts`
//     that finalizeDraftResponse itself builds. This harness does NOT call
//     that function and cannot reproduce its verdict.
//   - Phase 3b (D5 stated-total severity gate, `isTotalBrewTimeMismatchSevere`
//     deciding block-vs-warn for `total_brew_time_mismatch`) — LANDED IN
//     parser.ts (finalizeDraftResponse, parser.ts ~6172-6196). This
//     harness's verifyTimingProvenance call DOES compute the same
//     `total_brew_time_mismatch` finding (provenance.ts's own logic is
//     unchanged), so it is visible in this harness's timing-finding
//     output — but the harness has no equivalent of
//     `isTotalBrewTimeMismatchSevere` to decide whether that finding
//     should BLOCK, so it cannot reproduce the actual publish/block
//     decision.
//   - Phase 4 (D2 fold-index remap, `foldedDraftSteps.remapStepIndex`) —
//     LANDED IN parser.ts (finalizeDraftResponse, parser.ts ~5978-5990).
//     This harness passes each stage's OWN (pre-fold) step_index straight
//     into verifyAmountProvenance with no remapping, so a capture whose
//     only defect was fold drift will still show blocked here even though
//     production now correctly remaps and publishes it.
//
// Net effect: `harnessCanReplayFix: true` below means this harness's own
// replayed findings are suficient evidence for the expectation (D1 unit-
// lexicon cases). `harnessCanReplayFix: false` means the underlying fix is
// CONFIRMED LANDED by direct code reading, but this harness's bare-
// provenance.ts replay cannot itself prove it either way — a capture in
// that group showing "still blocked" or "still publishable" here is a
// HARNESS COVERAGE GAP, not evidence the fix regressed. See README.md
// "Coverage limitation" for what porting the rest would take.

export type Expectation = "must_block" | "must_publish" | "unchanged_control";

export type ExpectationEntry = {
  expectation: Expectation | "unknown";
  reason: string;
  /** Which plan phase this expectation depends on landing. "phase0" means
   * it should already hold with only the sourcing fix + Phase 1a (unit
   * lexicon) in place — no parser.ts change needed. */
  dependsOn:
    | "phase0-harness-only"
    | "phase1a-unit-lexicon"
    | "phase3a-range-collapse"
    | "phase3b-stated-total-ratio"
    | "phase4-step-renumbering"
    | "already-correct";
  /** True only when this harness's own verifyAmountProvenance/
   * verifyTimingProvenance replay is sufficient to prove the expectation.
   * False means the fix (confirmed landed in parser.ts by direct reading)
   * lives entirely outside provenance.ts, so this harness's verdict for
   * that capture is NOT evidence either way — see the module doc above. */
  harnessCanReplayFix: boolean;
};

export const EXPECTATIONS: Record<string, ExpectationEntry> = {
  // --- Arabic (D1-vocabulary: Phase 1a, unit lexicon) ---
  "01ea2cc9-9581-45bb-ba0f-91865e47ca73": {
    expectation: "must_publish",
    reason:
      "Arabic 1 — correct 40/140/220/300g draft blocked pre-Phase-1a on native-script units (جرام). Phase 1a's lexicon lives in provenance.ts, so this harness DOES exercise it directly.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },
  "0130ecae-daa5-417d-ae2b-a3c2002e96f2": {
    expectation: "must_publish",
    reason: "Arabic 2 — same shape as Arabic 1.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },
  "4f2627fa-f366-43a7-876a-41dc87087235": {
    expectation: "unchanged_control",
    reason:
      "Arabic 3 — already PASS in 015 (model happened to emit ASCII 'g'). Must stay publishable throughout.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "d74c8153-5ac0-4946-96b4-8e5d34c5c82f": {
    expectation: "must_publish",
    reason: "Arabic 4 — same shape as Arabic 1.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },

  // --- Persian ---
  "aac42d1a-d389-4d76-b513-6153e0ab5cd1": {
    expectation: "must_publish",
    reason:
      "Persian 1 — blocked pre-Phase-1a on native-script units. The 015 observation 'converted to g' unit instability is explicitly out of scope (plans/016 §7): once Phase 1 lands the checker stops caring which unit string was used, because g/ml are folded to the same mass_or_volume bucket. Lives in provenance.ts; this harness exercises it directly.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },

  // --- German (D1-empty-unit: Phase 1a) ---
  "9095df4f-c464-4f6f-b8da-07558f7a59ef": {
    expectation: "must_publish",
    reason:
      "German 1 — correct 25g bloom / 50-70g range draft blocked on the empty rendered unit for the range's low endpoint. The empty-unit compatibility rule lives in provenance.ts's unitsAreCompatible; this harness exercises it directly.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },
  "c2b63245-3316-4cda-aad5-bcd2b39caa6a": {
    expectation: "must_publish",
    reason: "German 2 — same shape as German 1.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },
  "584d658d-292c-4cd1-80b8-e3eb90371e03": {
    expectation: "must_publish",
    reason: "German 3 — same shape as German 1.",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },
  "a013c479-6768-40fc-9b80-1490c4d46566": {
    expectation: "must_publish",
    reason:
      "German 4 — same shape as German 1. Also THE sourcing-precedence regression case this fidelity fix exists for: raw extraction's step_index values (25->0, 50/70->1, 175/300->2) drift 2 from rendered steps and hard-block; normalization's re-emitted step_index values (25->1, 50/70->2, 175/300->3) drift <=1 and pass. Sourced from normalization (repair did not run for this capture).",
    dependsOn: "phase1a-unit-lexicon",
    harnessCanReplayFix: true,
  },

  // --- Chemex (D4: range collapse) ---
  "4a053b00-9e1e-4588-bcec-612b688df79b": {
    expectation: "unchanged_control",
    reason:
      "Chemex 1 (preserved) — both 60g and 90g bloom endpoints rendered explicitly. Must stay publishable through every phase.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "19351d6e-7fac-4a71-a403-d680e49f54e0": {
    expectation: "must_block",
    reason:
      "Chemex 2 (collapsed) — 60-90g bloom silently collapsed to 60g; the 90g endpoint is entirely absent from extracted_amounts (D4', no range_endpoint rule recorded), so even the landed Phase 3a check likely cannot catch THIS specific case (no trace of 90 to compare against) — see plans/016 D4' note. Confirmed by reading parser.ts (2026-08-12): findRangeEndpointCollapseIssues has already landed in finalizeDraftResponse, but it lives in parser.ts, not provenance.ts, so this bare-provenance.ts harness cannot exercise it either way regardless of whether it would catch this particular capture.",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },
  "3b75b610-6d22-43ad-9004-2403e9f92fb7": {
    expectation: "must_block",
    reason: "Chemex 4 (collapsed) — same shape as Chemex 2.",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },

  // --- Spanish (D4: range collapse, all recorded via range_endpoint rule) ---
  "2a638050-ea5e-4688-984b-6845da9ccc4f": {
    expectation: "must_block",
    reason:
      "Spanish 1 — 40-50ml bloom collapsed to 40ml, recorded as a range_endpoint record with distinct low/high (D4's original premise holds for this capture — the 90/50 endpoint IS present in extracted_amounts). Confirmed by reading parser.ts (2026-08-12): findRangeEndpointCollapseIssues has already landed in finalizeDraftResponse and is called with exactly this data shape, so production almost certainly already blocks this capture — but the check itself lives in parser.ts, not provenance.ts, so this harness cannot reproduce that verdict.",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },
  "de80f32e-2f89-49b0-861c-a189381d2ddf": {
    expectation: "must_block",
    reason: "Spanish 2 — same shape as Spanish 1.",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },
  "39499368-bfeb-4cae-8a59-395f8e3396ce": {
    expectation: "must_block",
    reason: "Spanish 3 — same shape as Spanish 1.",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },
  "f369b9b8-e631-410c-9e8a-d468e666a48b": {
    expectation: "must_block",
    reason:
      "Spanish 4 — same shape as Spanish 1. Also exercises the repair->non-empty precedence path directly (repair ran and re-emitted 5 records, all identical to normalization's).",
    dependsOn: "phase3a-range-collapse",
    harnessCanReplayFix: false,
  },

  // --- Russian (D5: stated-total contradiction) ---
  "d4b6cf9b-22af-4bf8-a982-240760f1cda6": {
    expectation: "must_block",
    reason:
      "Russian 1 — stated 180s total, final steps sum to 40s (a 4.5x contradiction). verifyTimingProvenance already computes and reports this finding (D5, provenance.ts:570) — this harness DOES surface it as a timing finding in its own output — but the block-vs-warn DECISION for it (isTotalBrewTimeMismatchSevere) is confirmed already landed in parser.ts's finalizeDraftResponse (2026-08-12), entirely outside provenance.ts, so this harness cannot reproduce whether production now blocks it.",
    dependsOn: "phase3b-stated-total-ratio",
    harnessCanReplayFix: false,
  },
  "d0ee168d-35f7-4548-8b5b-ee020f62ed41": {
    expectation: "must_block",
    reason: "Russian 2 — same shape as Russian 1.",
    dependsOn: "phase3b-stated-total-ratio",
    harnessCanReplayFix: false,
  },
  "317fc7b6-572b-44f3-9513-3c2335526a64": {
    expectation: "must_block",
    reason:
      "Russian 3 — same shape as Russian 1 (explicitly named in the task brief: '40s vs stated 180s, must block').",
    dependsOn: "phase3b-stated-total-ratio",
    harnessCanReplayFix: false,
  },
  "875cb636-9df1-441f-aef0-14b7734f1cc4": {
    expectation: "unchanged_control",
    reason:
      "Russian 4 — already correct (180s total matches, zero timing findings expected). Must stay publishable through every phase; also the Phase 3b tolerance-ratio control's near neighbour (cold brew is the 0.05%-drift control; this is the 0%-drift Russian control). This harness CAN confirm the 'no finding at all' half, even though it cannot confirm the severity-gate logic for captures that DO produce a finding.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },

  // --- Hario full transcript (D2: step-index drift from fold) ---
  "9e544315-8816-43f1-b44b-cae57c1c51b1": {
    expectation: "must_publish",
    reason:
      "Hario full 1 — correct 95s draft blocked because the pre-timer 20g dose folds into preparation and its recorded step_index drifts from the rendered step. Confirmed by reading parser.ts (2026-08-12): foldedDraftSteps.remapStepIndex has already landed in finalizeDraftResponse and is applied to extracted_amounts before verifyAmountProvenance runs — but this harness passes each stage's RAW (pre-fold) step_index straight in with no remapping, so it cannot reproduce that fix.",
    dependsOn: "phase4-step-renumbering",
    harnessCanReplayFix: false,
  },
  "73d98291-39bf-4eba-8b7d-5baf4ed1da5a": {
    expectation: "must_publish",
    reason: "Hario full 2 — same shape as Hario full 1.",
    dependsOn: "phase4-step-renumbering",
    harnessCanReplayFix: false,
  },
  "fe3c6b8a-dbd0-412e-bfcd-be5ba8258c38": {
    expectation: "must_publish",
    reason:
      "Hario full 3 — explicitly named in the task brief: 'blocked by step-binding, must pass after Phase 4.' Phase 4 is confirmed landed in parser.ts, but not in provenance.ts — see Hario full 1's reason.",
    dependsOn: "phase4-step-renumbering",
    harnessCanReplayFix: false,
  },
  "127f391d-a6f1-4375-a6dc-9d644a9fc9f8": {
    expectation: "unchanged_control",
    reason:
      "Hario full 4 — already PASS in 015 (no fold-drift finding to begin with). Must stay publishable through every phase; this harness CAN confirm the no-finding half.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },

  // --- Built-in sample (D3': verify-mode wording — parser.ts only, not G22) ---
  "07b2d1da-5eac-4490-b8fe-43e8c6e7b0c2": {
    expectation: "unchanged_control",
    reason:
      "Built-in sample 1 — already publishable (is_publishable=true, zero validation issues) in 015; the regression there was WORDING (timestamp/'pour to' rewriting), which this harness's diffVerifyModeWording section surfaces separately but which the mode-gated branch of normalizeStepDescriptionTemplate fixes in parser.ts (confirmed already landed, 2026-08-12), entirely outside provenance.ts. Amount-provenance verdict must stay unchanged (publishable, zero amount findings) throughout — this harness CAN confirm that half.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "4110194d-02ba-4d91-b168-ba98e979b746": {
    expectation: "unchanged_control",
    reason: "Built-in sample 2 — same as sample 1.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "ec152117-b53c-47c9-a732-185a1bc811f6": {
    expectation: "unchanged_control",
    reason: "Built-in sample 3 — same as sample 1.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "5b819ce9-7bb4-47eb-b322-0c621f0755af": {
    expectation: "unchanged_control",
    reason: "Built-in sample 4 — same as sample 1.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },

  // --- Regression controls (plans/015 "Regression controls") ---
  "1f30b890-c585-4e51-bd10-f655914cf667": {
    expectation: "unchanged_control",
    reason: "Kalita control — PASS in 015. Must stay publishable throughout.",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "508382e8-dbda-4867-bb87-479c204c6d07": {
    expectation: "unchanged_control",
    reason:
      "Cold brew control — correctly non-publishable in 015 (missing water_temp/brewing_method, both OUT of provenance.ts's scope — this harness only checks amount/timing traceability, never recipe completeness). Also the Phase 3b tolerance control: 64,830s emitted against a stated 64,800s (0.05% drift) must NEVER trip a ratio-based stated-total check — this harness CAN confirm verifyTimingProvenance itself produces zero timing findings for this drift (the tolerance math is unchanged, in provenance.ts), even though it cannot confirm the severity-GATE wiring around it (parser.ts, out of reach).",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
  "e1297072-528a-42c9-9d67-bb47816edd65": {
    expectation: "unchanged_control",
    reason:
      "Under-specified control — correctly non-publishable in 015 (missing coffee/water amounts, brewing method — outside provenance.ts's scope). Must stay non-publishable throughout for those unrelated reasons. Also exercises the 'repair ran, succeeded per this harness's proxy, but re-emitted an EMPTY extracted_amounts' fallback path in selectAmountProvenanceSource (falls straight to raw extraction, which is also empty here — zero amounts stated in the source).",
    dependsOn: "already-correct",
    harnessCanReplayFix: true,
  },
};

export function lookupExpectation(id: string): ExpectationEntry {
  return EXPECTATIONS[id] ?? {
    expectation: "unknown",
    reason:
      "no expectation recorded for this capture id — not part of the plans/016 §6 / plans/015 matrix this manifest was built from.",
    dependsOn: "phase0-harness-only",
    harnessCanReplayFix: false,
  };
}
