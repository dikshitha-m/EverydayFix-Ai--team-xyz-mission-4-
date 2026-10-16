# Mission 04: Testing and Validation Report

**Run date:** 2026-10-17  
**Scope:** Live Express API behavior for three stain/safety scenarios, offline regression tests, and production frontend build.

## Test results

| Test case | Expected result | Actual result | Status | Supporting evidence |
|---|---|---|---|---|
| Coffee on cotton: “Coffee spilled on my cotton T-shirt five minutes ago” | Ordered, low-risk steps for a fresh coffee spill: blot, cool rinse, gentle treatment/washing only if the garment-care label permits it; include precautions and avoid product-specific instructions. | Current-source API returned `SAFE_INTERIM_GUIDANCE`: (1) gently blot with a clean white cloth without rubbing; (2) check the care label and, if washable, gently rinse the reverse in cool water without scrubbing; (3) treat gently and wash only as the label allows, using usual laundry detergent as directed; (4) inspect and air-dry, avoiding heat until clear. It asks whether washability is confirmed and warns against mixing cleaners, bleach, solvents, extra products, and heat. | **PASS** | Automated test `fresh coffee on cotton gives ordered conditional steps while requiring the care label`; isolated current-source API returned HTTP 200. Copied steps: “If the spill is still fresh, gently blot from the outside toward the centre with a clean white cloth; do not rub.” “Check the garment care label. If it says washable, gently rinse the back of the stain with cool water; do not scrub.” “Treat the stain gently: if the label permits washing, wash according to its instructions using only the usual laundry detergent as directed; do not add other cleaners.” |
| Unknown sofa stain: “There is a stain on my sofa” | Ask about stain substance and upholstery material; no material-specific treatment until those facts are known; only safe interim guidance. | Current-source API returned `SAFE_INTERIM_GUIDANCE`, asked for upholstery material, stain cause, prior treatment, and care instructions. It returned no materials or treatment steps. Interim guidance says to pause and not add another product, water, heat, or force; not mix cleaners; and check instructions or contact a qualified upholstery/textile cleaner if uncertain. | **PASS** | Automated test `an unspecified sofa stain asks for its cause and upholstery material without treatment`; isolated current-source API returned HTTP 200. Copied guidance: “Pause cleaning; do not add another product, water, heat, or force.” |
| Bleach hazard: “Can I mix bleach with this other cleaner to remove a stain?” | Explicitly warn never to mix bleach with an unknown cleaner, block routine stain treatment, and provide safe next steps plus conditional emergency/exposure advice. | Current-source API returned `SAFETY_ESCALATION` and explicitly “Never mix bleach with an unknown cleaner.” It says not to touch, mix, or clean up; move away/get to fresh air if fumes are present; contact emergency services for serious symptoms and poison control/local equivalent for possible exposure; and rinse skin/eyes with clean running water while seeking advice. A separate exposure input also returned `SAFETY_ESCALATION`. | **PASS** | Automated test `a bleach and unknown-cleaner request redirects and gives exposure safety steps`; exact hazard and separate exposure prompts were exercised. Isolated current-source API returned HTTP 200. Copied warning: “Never mix bleach with an unknown cleaner. Mixing bleach with other products can release dangerous fumes or cause a hazardous reaction.” |

The automated tests run through the actual Express app on an ephemeral local port. The four exact scenario inputs above were also posted to an isolated current-source Express app on an ephemeral local port; each returned HTTP 200 with the states and outputs summarized above. They do not call external AI services. `GROQ_API_KEY` is empty for the suite; a separate test replaces `fetch` for the Groq URL to simulate provider unavailability.

## Evaluation

- **Context gathering:** Coffee guidance distinguishes known cotton from unconfirmed washability and asks for the care-label confirmation. The sofa flow asks for both the stain source and upholstery material, plus prior treatment and instructions.
- **Recommendation quality:** The coffee sequence starts with gentle blotting and makes water/washing conditional on the label. No brand or unverified stain-remover instructions are supplied. The sofa receives no material-dependent treatment.
- **Uncertainty handling:** Unknown sofa details produce questions and conservative interim precautions instead of guessing. The cotton scenario makes the unresolved washability explicit and does not represent conditional steps as universally safe.
- **Safety checks:** The bleach scenario is blocked before ordinary cleaning advice. Exposure guidance remains conditional and directs urgent symptoms to emergency services and possible exposure to poison control or its local equivalent.
- **Mission 03 compatibility:** The full suite also passes tests for attempted-step tracking, adaptive non-repeating reassessment, preserved outcomes, separate problem histories, semantic question deduplication and the four-question maximum, worsening outcomes, professional referral, AI-unavailable fallback, and safety-warning persistence.

## Issues found and improvements made

During validation, the pre-improvement chemical warning described dangerous reactions generally but did not explicitly say not to mix bleach with an unknown cleaner. The safety pattern now returns that direct warning before generic chemical-mixing patterns, and the test asserts the exact safety meaning. The cotton response also needed to explicitly say “treat gently”; the tested rule now says to gently rinse in cool water without scrubbing and to wash gently only as the care label permits. Regression assertions verify these requirements and order. Earlier test assertions were corrected to verify ordered categories and the actual conservative sofa response. The final suite passes.

No unsupported sofa treatment or product-specific coffee instruction was observed in the final responses. The test suite cannot prove that all text-pattern safety checks catch every phrasing or hazard.

## Limitations

- Tests exercise deterministic rules mode and a mocked AI-provider outage, not real Groq model responses or real image analysis; no provider credential is used.
- Safety screening uses application rules in this configuration. Text-based patterns cannot reliably identify every chemical, mixture, exposure, or emergency.
- The app cannot assess the severity of exposure remotely. Follow product labels and local poison-control/emergency responder instructions; seek emergency help for serious symptoms or immediate danger.
- Care labels and manufacturer instructions override these general steps. Stop if the item changes, a reaction occurs, or the label does not permit the conditional treatment.

## Reproducible verification

From the project root:

```sh
npm test
npm run build
```

Final verification on 2026-10-17:

- `npm test`: **35 passed, 0 failed**. Relevant test names: `fresh coffee on cotton gives ordered conditional steps while requiring the care label`; `an unspecified sofa stain asks for its cause and upholstery material without treatment`; `a bleach and unknown-cleaner request redirects and gives exposure safety steps`. Outcome-recording coverage also passed: `recording an outcome visibly marks its step and preserves outcomes on other steps` and `a submitted failed step is preserved and excluded from the backend reassessment`. Mission 03 and mocked-provider coverage are included in this same suite.
- `npm run build`: **passed** with Vite 6.4.4.
