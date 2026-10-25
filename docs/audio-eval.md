# Audio classifier evaluation (leave-one-clip-out)

Dataset: /home/claude/ww/data/clips
Clips: 32 ({"generator":8,"grid_hum":8,"silence":8,"other":8}), windows evaluated: 1007

Only YOUR recordings appear here. Nothing in this file is synthetic.

## Confusion matrix (windows)
```
true \ predicted   generator   grid_hum    silence      other
generator                225         24          0         14
grid_hum                   0        239          0          8
silence                    0          9        235          0
other                      0          1          0        252
```

## Per class
| class | precision | recall | windows |
|---|---|---|---|
| generator | 1.000 | 0.856 | 263 |
| grid_hum | 0.875 | 0.968 | 247 |
| silence | 1.000 | 0.963 | 244 |
| other | 0.920 | 0.996 | 253 |

Overall window accuracy: 0.944

## Confidence behaviour (is confidence meaningful?)
| threshold | windows kept | accuracy among kept |
|---|---|---|
| 0.5 | 100.0% | 94.4% |
| 0.6 | 99.8% | 94.5% |
| 0.7 | 98.8% | 94.9% |
| 0.8 | 97.9% | 94.9% |
| 0.9 | 96.3% | 95.2% |
| 0.95 | 94.5% | 95.6% |

## Worst clips
| clip | windows | accuracy |
|---|---|---|
| generator/audio_2026-10-24_02-03-03.wav | 31 | 9.7% |
| silence/audio_2026-10-24_01-32-56.wav | 30 | 70.0% |
| grid_hum/audio_2026-10-24_01-29-24.wav | 31 | 74.2% |
| generator/audio_2026-10-23_01-10-31.wav | 31 | 80.6% |
| generator/audio_2026-10-23_01-10-16.wav | 34 | 88.2% |
| other/audio_2026-10-23_01-13-41.wav | 34 | 97.1% |
| generator/audio_2026-10-23_01-04-58.wav | 32 | 100.0% |
| generator/audio_2026-10-23_01-08-38.wav | 34 | 100.0% |

## Clips with rejected windows (clipping or dead microphone)

## Feasibility gate
- [x] at least 8 clips in every class ({"generator":8,"grid_hum":8,"silence":8,"other":8})
- [ ] generator recall >= 0.9 (0.856)
- [x] generator precision >= 0.9 (1.000)
- [ ] generator<->grid_hum confusion <= 0.05 each way (gen->grid 0.091, grid->gen 0.000)
- [x] no clips skipped by the evaluator (0)

**Verdict: GATE NOT PASSED**

Passing means: on these recordings, from these sessions, the classifier meets the pre-set bar. It does not show that the classifier generalises to other generators, rooms or phones, and it does not defend against replayed audio.
