# Planner eval: section "qualifies" precision / recall

Model `claude-haiku-5-5`, 26 labelled videos (`labels.json`, labelled from captions and storyboard frames). Regenerate with `python -m app.planner.evaluate run && python -m app.planner.evaluate score` from `backend/`.

| Metric | Value |
| --- | --- |
| Section precision (qualifies) | **1.000** (78 / 78; 95% lower bound 0.953) |
| Section recall (qualifies) | **0.830** (78 / 94) |
| Time-weighted precision | 0.991 |
| Time-weighted recall | 0.871 |
| Video verdict accuracy (coding vs not_coding) | 0.885 |
| Pauses inside labelled teaching, before a labelled answer | 1.000 (80 / 80) |

Bar: auto-pause turns on when section precision >= 0.9 in every run. Result: **met, auto-pause on**.

## Repeat runs (same labels, same captions)

| Run | Precision | Recall | Time precision | Time recall | Verdict accuracy | Pauses ok |
| --- | --- | --- | --- | --- | --- | --- |
| `results.json` | 1.000 | 0.830 | 0.991 | 0.871 | 0.885 | 1.000 |
| `results-run2.json` | 1.000 | 0.782 | 0.997 | 0.787 | 0.923 | 1.000 |
| `results-v1-run1.json` | 0.918 | 0.876 | 0.935 | 0.866 | 0.923 | 0.987 |
| `results-v1-run2.json` | 0.962 | 0.874 | 0.944 | 0.818 | 0.885 | 0.974 |

## Per video

| Video | Category | Labelled coding | Status | TP | FP | FN | TN | Pauses ok | Wrong pauses (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kqtD5dpn9C8` Python for Beginners - Learn Coding with Python in | tutorial | yes | classified | 10 | 0 | 0 | 2 | 7/7 | - |
| `ZDa-Z5JzLYM` Python OOP Tutorial 1: Classes and Instances (Core | tutorial | yes | classified | 5 | 0 | 1 | 1 | 3/3 | - |
| `W6NZfCO5SIk` JavaScript Course for Beginners (Mosh) | tutorial | yes | classified | 7 | 0 | 2 | 4 | 9/9 | - |
| `eIrMbAQSU34` Java Full Course for Beginners (Mosh) | tutorial | yes | classified | 7 | 0 | 0 | 5 | 7/7 | - |
| `vLnPwxZdW4Y` C++ Tutorial for Beginners - Full Course (Giraffe  | tutorial | yes | classified | 3 | 0 | 1 | 4 | 7/7 | - |
| `KJgsSFOSQv0` C Programming Tutorial for Beginners (Giraffe Acad | tutorial | yes | classified | 4 | 0 | 0 | 4 | 3/3 | - |
| `GhQdlIFylQ8` C# Tutorial - Full Course for Beginners (Giraffe A | tutorial | yes | classified | 4 | 0 | 0 | 2 | 5/5 | - |
| `HXV3zeQKqGY` SQL Tutorial - Full Database Course for Beginners | tutorial | yes | not_coding | 0 | 0 | 1 | 2 | 0/0 | - |
| `SqcY0GlETPk` React Tutorial for Beginners (Mosh) | tutorial | yes | classified | 6 | 0 | 3 | 6 | 7/7 | - |
| `rfscVS0vtbw` Learn Python - Full Course for Beginners (freeCode | tutorial | yes | classified | 4 | 0 | 0 | 3 | 7/7 | - |
| `kCc8FmEb1nY` Let's build GPT: from scratch, in code, spelled ou | tutorial | yes | classified | 6 | 0 | 1 | 2 | 7/7 | - |
| `0IAPZzGSbME` 1. Introduction to Algorithms (Abdul Bari) | theory | no | not_coding | 0 | 0 | 0 | 2 | 0/0 | - |
| `mB5HXBb_HY8` 2.7.2. Merge Sort Algorithm (Abdul Bari) | theory | yes | classified | 5 | 0 | 0 | 0 | 4/4 | - |
| `pTB0EiLXUC8` Object-Oriented Programming, Simplified (Mosh) | theory | yes | classified | 4 | 0 | 1 | 1 | 2/2 | - |
| `oBt53YbR9Kk` Dynamic Programming - Learn to Solve Algorithmic P | theory | yes | classified | 8 | 0 | 0 | 1 | 7/7 | - |
| `x7X9w_GIm1s` Python in 100 Seconds (Fireship) | mixed | yes | classified | 1 | 0 | 1 | 1 | 1/1 | - |
| `446E-r0rXHI` Go in 100 Seconds (Fireship) | mixed | yes | not_coding | 0 | 0 | 2 | 1 | 0/0 | - |
| `8mAITcNt710` Harvard CS50 – Full Computer Science University Co | mixed | yes | classified | 4 | 0 | 0 | 1 | 4/4 | - |
| `-DVyjdw4t9I` Guido van Rossum: Python and the Future of Program | code_mentioning | no | not_coding | 0 | 0 | 0 | 5 | 0/0 | - |
| `zjkBMFhNj_g` [1hr Talk] Intro to Large Language Models (Karpath | code_mentioning | no | not_coding | 0 | 0 | 0 | 5 | 0/0 | - |
| `aircAruvnKk` But what is a neural network? (3Blue1Brown) | code_mentioning | yes | not_coding | 0 | 0 | 3 | 2 | 0/0 | - |
| `dQw4w9WgXcQ` Rick Astley - Never Gonna Give You Up | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `iG9CE55wbtY` Do schools kill creativity? | Sir Ken Robinson | T | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `UF8uR6Z6KLc` Steve Jobs' 2005 Stanford Commencement Address | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `arj7oStGLkU` Inside the Mind of a Master Procrastinator | Tim U | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `spUNpyF58BY` But what is the Fourier Transform? A visual introd | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |

## Misclassified sections

Labelled share = fraction of the section's time labelled as qualifying (>= 0.5 counts as qualifying).

| Video | Kind | Span (s) | Labelled share | Format | Confidence | Section title |
| --- | --- | --- | --- | --- | --- | --- |
| `ZDa-Z5JzLYM` | FN | 0-88 | 0.61 | theory | high | Intro and why use classes |
| `W6NZfCO5SIk` | FN | 203-274 | 0.76 | code | high | Trying JavaScript in the browser console |
| `W6NZfCO5SIk` | FN | 696-940 | 0.57 | mixed | medium | Separating JavaScript into a file and running it with Node |
| `vLnPwxZdW4Y` | FN | 2361-2400 | 1.00 | code | low | Strings: string literals and plain text |
| `HXV3zeQKqGY` | FN | 1390-2400 | 1.00 | theory | medium | Tables, primary keys, foreign keys and composite keys |
| `SqcY0GlETPk` | FN | 549-677 | 0.60 | theory | high | Tour of the generated project files |
| `SqcY0GlETPk` | FN | 1016-1147 | 0.95 | theory | medium | Virtual DOM and React DOM |
| `SqcY0GlETPk` | FN | 1542-1627 | 1.00 | mixed | medium | Editor shortcuts and Prettier formatter setup |
| `kCc8FmEb1nY` | FN | 469-511 | 0.74 | code | medium | Setting up a Colab notebook and loading the dataset |
| `pTB0EiLXUC8` | FN | 388-410 | 1.00 | theory | medium | Recap of the benefits of each concept |
| `x7X9w_GIm1s` | FN | 108-145 | 0.73 | theory | high | Paradigms, ecosystem and outro |
| `446E-r0rXHI` | FN | 43-84 | 0.59 | code | high | Installing Go and running Hello World |
| `446E-r0rXHI` | FN | 84-151 | 0.84 | mixed | low | Go syntax overview: dependencies, variables, pointers and concurrency |
| `aircAruvnKk` | FN | 178-488 | 0.99 | theory | high | Neurons, activations and layers |
| `aircAruvnKk` | FN | 488-807 | 1.00 | theory | high | Weights, biases and the sigmoid squishing function |
| `aircAruvnKk` | FN | 807-988 | 1.00 | theory | high | Matrix notation and the network as a function |
