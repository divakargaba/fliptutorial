# Hint and efficiency captures

28 PNGs from the local fixture suite; no live provider requests.

- `mv3-desktop-*` / `mv3-narrow-*`: actual built extension at 1440×900 / 1024×768. Wrong-answer feedback, three exhausted hints, pending analysis, inefficient pass with disclosure closed/open, and efficient pass before auto-resume.
- `preview-desktop-showcase-*` / `preview-narrow-showcase-*`: existing showcase states `failed`, `solved`, `solved-slow`, `solved-checking`, each in dark/light themes. Component stubs, separate from the MV3 integration proof.

The shared analysis fixture illustrates a pair-search optimization; it is used
to verify rendering and playback behavior, not to grade an exponent solution.
See [acceptance instructions](../../../tests/e2e/README.md) for regeneration commands.
