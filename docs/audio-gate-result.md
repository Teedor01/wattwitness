# Real-audio gate: result and history

**Verdict: GATE NOT PASSED.** Live sensing stays locked. The demo uses recorded clips and a synthetic demo model.

The pass mark was fixed before any real data was collected (see `docs/phase3-plan.md`):
generator recall at least 0.90, generator precision at least 0.90, generator versus grid hum
confusion at most 5% each way, at least 8 clips per class, no clip skipped.

## Dataset

32 of our own recordings, 8 per class (`generator`, `grid_hum`, `silence`, `other`), about 60 seconds
each, recorded on one phone. The recordings were saved as Ogg Opus (a lossy voice codec) with a `.wav`
file name, and were converted to 16 kHz mono PCM WAV before testing. The clips are not committed to git
(privacy: `other` may contain speech). `docs/audio-eval.md` is the generated report from the final run.

## All runs, in order

| Run | What changed | Generator recall | Generator to grid hum | Result |
|---|---|---|---|---|
| 1 | First dataset | 0.863 | 0.004 | Not passed. Two `other` clips were later found to be byte-identical, so that class had only 7 distinct clips. |
| 2 | Duplicate `other` clip replaced with a new recording | 0.863 | 0.004 (grid hum to generator: 0.049) | Not passed (recall). |
| 3 | One generator clip removed and one new generator clip added | 0.856 | 0.091 | Not passed (recall and generator to grid hum confusion). |

Details of the changes:

* **Run 1 to 2:** `other/audio_2026-10-23_01-12-08.wav` was identical to `01-12-25` and was replaced by
  `other/audio_2026-10-24_01-49-03.wav`.
* **Run 2 to 3:** `generator/audio_2026-10-23_01-10-51.wav` (very quiet, about -37 dBFS, only 3.2% of its
  windows classified correctly) was removed and `generator/audio_2026-10-24_02-03-03.wav` was added. The new
  clip was also mostly misclassified (9.7% of windows correct, mostly read as grid hum).

The pass mark was not changed at any point.

## What the result means

* The classifier did not meet the bar on our recordings, so we make no claim of live generator detection.
* The generator class contains several spectrally different conditions (dominant tones from about 500 Hz to
  900 Hz in some clips, much more energy above 1 kHz in others). Eight clips do not cover them.

## Known weaknesses of the dataset

* Each class was largely recorded in a different sitting (generator and `other` on Oct 23, grid hum and
  silence on Oct 24, the final generator clip later on Oct 24). Differences between sittings could help or
  hurt the classifier, so even a pass would not have shown that it hears the sound rather than the session.
  The evaluation script does not enforce the two-session rule; that was left to us.
* Opus compression may have altered low-frequency content compared with the raw microphone the app hears.
* Eight clips per class is the minimum set by the plan, not a large dataset.
