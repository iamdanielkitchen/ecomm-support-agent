# Postmortem notes — Path 2 build

Scratch file for findings to incorporate into the full writeup later.
Notes appended during the build, not edited for polish.

1. Short queries score lower than long queries on voyage-4-lite.
   Observed in threshold calibration: "how do I return something I
   opened" scored 0.390 while semantically-exact match. Asymmetry
   is known in document-vs-query embedding spaces. Mitigation if
   needed: query-expansion step before retrieval.

2. Dual-signal confidence surfaced a structural disagreement.
   Self-scored (Haiku, no context) and retrieval-derived signals
   disagree on grounded-but-confident-sounding replies. Haiku
   cannot distinguish "quoted from retrieved chunk" from
   "fabricated from nothing" because the scorer doesn't see the
   chunks. Retrieval-derived confidence is the more reliable
   signal for grounded replies; self-scored is useful for catching
   hedged/empty replies. Future work: pass chunks into self-scorer
   for a third "grounded-in-context" signal.

3. Escalation distinction matters more than escalation coverage.
   Hard escalation via tool is for authority-bounded problems
   (payment, policy exceptions, account access). Soft verbal
   offers handle out-of-catalog curiosity without consuming human
   agent tickets. Naive "escalate everything the bot can't answer"
   design multiplies human-agent load without adding value.

4. Generic weekend RAG builds hide failure modes; this one
   surfaces them. Trace view exposes (a) retrieval quality per
   turn, (b) agent re-query behavior, (c) grounding vs.
   fabrication distinction. The debug view is the interview
   surface.
