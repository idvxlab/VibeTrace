## Evidence Method: Successful Single Trace

Treat the trace as a **successful user session**, not a benchmark pass. The user intent section is the main anchor.

1. Quote or paraphrase the user goal from `User intent` before analyzing actions.
2. Separate the shortest verified path from incidental exploration, retries, and redundant steps.
3. Extract a workflow that would help the **next user with a similar request**—collaboration rules, API integration steps, UI feature pattern, **or error→fix playbook** if the trace includes failed actions then recovery.
4. If the trace shows **errors then a successful fix** (agent or user), distill the fix path — not only the happy path.
5. Prefer the shortest verified sequence. Include investigation only when it replaces observed waste or encodes a repeatable “research first” step the user asked for.
6. **Do emit** create/revise when the user asked for a reusable pattern (API proxy, git flow, feature template, **fix for a named error**) even if the run was fast and error-free at the end.
7. Emit nothing only for pure one-off trivia with no similar future user phrasing.
