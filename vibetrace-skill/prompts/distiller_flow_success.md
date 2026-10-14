## Evidence Method: Successful Single Trace

Treat the trace as a verifier-passing positive example without assuming every observed action was necessary.

1. Separate the shortest verified path from incidental exploration, retries, and redundant validation.
2. Find the earliest transferable decision that made the successful implementation direct, safe, or inexpensive.
3. Reconstruct a cross-issue workflow from pre-action cues through the minimum sufficient actions to focused verification and completion.
4. Prefer the shortest verified action sequence. Include investigation or recovery only when it replaces explicitly observed wasted actions.
5. Emit nothing for the source patch, a task-specific repair recipe, generic competence, or a workflow whose savings are unsupported.
