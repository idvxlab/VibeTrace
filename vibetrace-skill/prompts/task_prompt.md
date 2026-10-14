Work in the codebase at `{{LOCATION}}`.

## Coding Request

<user_request>
{{PROBLEM_STATEMENT}}
</user_request>

Complete the coding request in the current codebase.

## Requirements

- Treat the user request as the source of scope, constraints, and acceptance criteria.
- Preserve unrelated behavior, artifacts, and public interfaces.
- Do not weaken or modify validation merely to make an incorrect implementation appear successful.
- Before broad exploration, review the available project skill descriptions. Load a skill when its positive pre-action cues match this request and its negative cues do not. Repository or subsystem overlap alone is insufficient; when no description matches, continue without loading a skill.
- Trace the affected behavior before editing, fix the root cause with the smallest sufficient change, and run the narrowest check that can establish the requested behavior without omitting necessary regression coverage.

In the final response, briefly state the implementation result and any validation performed.
