## Evidence Method: Failed Single Trace

Treat the trace as evidence about **errors, recovery, and verified fixes** for similar future user requests.

1. Restate user intent first. Check **feedback messages** — user may have supplied the fix directly.
2. Identify error actions (`[x ...]` in retained actions), tool failures, and what changed before success (if any).
3. **Eligible to emit CREATE/REVISE** when you can document:
   - **Symptom** (error text, HTTP code, user complaint)
   - **Verified fix** that worked — whether discovered by agent **or given by user**
   - **Avoid** — failed attempts in trace (do not encode as positive steps)
4. Prefer revising/removing a harmful invoked skill when causally supported.
5. Never encode the **broken attempt alone** as positive guidance; always pair with the fix that evidence supports.
6. Emit nothing only when errors are one-off noise with no symptom pattern and no verified recovery.
