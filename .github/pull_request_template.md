## Summary

<!-- What changed and why, in 1-3 sentences. -->

## Checklist

- [ ] `npm run check` passes locally
- [ ] Layering respected (`src/domain` -> `src/platform` -> `src/app` -> entry points; no reverse imports, no `chrome` outside `src/platform/**` and the three entry files)
- [ ] `unknown` / `error` / `closed` are handled as distinct from `progress: 0` — no stale value reused on a failed read
- [ ] Any new boundary value (message, stored value, URL) is parsed into `Result` at the `src/domain/` boundary, not cast
- [ ] No new host permission added without authorization for that specific site
- [ ] No claim, in code/UI/docs/commit message, that more tabs produce more or better queue entries
- [ ] Tests added to the correct tier (`unit` / `dom` / `integration` / `security`) for the area touched
- [ ] No real timers or real sleeps in tests (`FakeClock` / `FakeTimers` only)

## Validation actually run

<!-- State what you actually ran, not what would be nice to have. -->

- [ ] Loaded the unpacked extension in Chrome and exercised the change manually (the platform adapter has no automated coverage — this is the only way to validate it)
- Commands run:
- Manual steps taken:
- Known gaps / unverified coverage:
