**What this changes**

**How you verified it**

<!-- Commands you ran, and what you saw. `bun run check` is the baseline. -->

**Checklist**

- [ ] `bun run check` passes
- [ ] A test covers the change, if it fixes a bug
- [ ] New flags are listed in `FLAGS` in `src/cli.ts` (and `VALUE_FLAGS` if they take a value)
- [ ] No credential value is read into anything that could be printed or logged
- [ ] Docs updated if behaviour changed (`README.md`, `ARCHITECTURE.md`, or a `cs help` topic)
