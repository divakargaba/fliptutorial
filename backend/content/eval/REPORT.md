# Planner eval: section "qualifies" precision / recall

Model `claude-haiku-5-5`, 26 labelled videos (`labels.json`, labelled from captions and storyboard frames). Regenerate with `python -m app.planner.evaluate run && python -m app.planner.evaluate score` from `backend/`.

| Metric | Value |
| --- | --- |
| Section precision (qualifies) | **1.000** (79 / 79; 95% lower bound 0.954) |
| Section recall (qualifies) | **0.814** (79 / 97) |
| Time-weighted precision | 0.988 |
| Time-weighted recall | 0.804 |
| Video verdict accuracy (coding vs not_coding) | 0.885 |
| Pauses inside labelled teaching, before a labelled answer | 1.000 (74 / 74) |
| Planned coding : concept (MC) pauses | **45 : 29** (previous rule, concept_complete always MC: 20 : 54) |

Planned kinds are before generation; a coding pause whose exercise fails generation or the sandbox verify still falls back to a concept question.

Bar: auto-pause turns on when section precision >= 0.9 in every run. Result: **met, auto-pause on**.

## Repeat runs (same labels, same captions)

| Run | Precision | Recall | Time precision | Time recall | Verdict accuracy | Pauses ok | Coding : MC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `results-run3.json` | 1.000 | 0.814 | 0.988 | 0.804 | 0.885 | 1.000 | 45 : 29 |
| `results.json` | 1.000 | 0.830 | 0.991 | 0.871 | 0.885 | 1.000 | 50 : 30 |
| `results-run2.json` | 1.000 | 0.782 | 0.997 | 0.787 | 0.923 | 1.000 | 45 : 31 |

## Per video

| Video | Category | Labelled coding | Status | TP | FP | FN | TN | Pauses ok | Wrong pauses (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kqtD5dpn9C8` Python for Beginners - Learn Coding with Python in | tutorial | yes | classified | 10 | 0 | 0 | 2 | 7/7 | - |
| `ZDa-Z5JzLYM` Python OOP Tutorial 1: Classes and Instances (Core | tutorial | yes | classified | 3 | 0 | 0 | 2 | 3/3 | - |
| `W6NZfCO5SIk` JavaScript Course for Beginners (Mosh) | tutorial | yes | classified | 8 | 0 | 3 | 5 | 9/9 | - |
| `eIrMbAQSU34` Java Full Course for Beginners (Mosh) | tutorial | yes | classified | 8 | 0 | 1 | 5 | 7/7 | - |
| `vLnPwxZdW4Y` C++ Tutorial for Beginners - Full Course (Giraffe  | tutorial | yes | classified | 4 | 0 | 0 | 3 | 5/5 | - |
| `KJgsSFOSQv0` C Programming Tutorial for Beginners (Giraffe Acad | tutorial | no | classified | 4 | 0 | 0 | 4 | 4/4 | - |
| `GhQdlIFylQ8` C# Tutorial - Full Course for Beginners (Giraffe A | tutorial | no | classified | 4 | 0 | 0 | 3 | 6/6 | - |
| `HXV3zeQKqGY` SQL Tutorial - Full Database Course for Beginners | tutorial | no | not_coding | 0 | 0 | 1 | 2 | 0/0 | - |
| `SqcY0GlETPk` React Tutorial for Beginners (Mosh) | tutorial | no | classified | 2 | 0 | 1 | 4 | 4/4 | - |
| `rfscVS0vtbw` Learn Python - Full Course for Beginners (freeCode | tutorial | yes | classified | 4 | 0 | 0 | 3 | 7/7 | - |
| `kCc8FmEb1nY` Let's build GPT: from scratch, in code, spelled ou | tutorial | yes | classified | 10 | 0 | 2 | 1 | 7/7 | - |
| `0IAPZzGSbME` 1. Introduction to Algorithms (Abdul Bari) | theory | no | not_coding | 0 | 0 | 0 | 2 | 0/0 | - |
| `mB5HXBb_HY8` 2.7.2. Merge Sort Algorithm (Abdul Bari) | theory | no | classified | 4 | 0 | 0 | 0 | 4/4 | - |
| `pTB0EiLXUC8` Object-Oriented Programming, Simplified (Mosh) | theory | no | classified | 5 | 0 | 0 | 1 | 2/2 | - |
| `oBt53YbR9Kk` Dynamic Programming - Learn to Solve Algorithmic P | theory | yes | classified | 11 | 0 | 0 | 1 | 7/7 | - |
| `x7X9w_GIm1s` Python in 100 Seconds (Fireship) | mixed | no | not_coding | 0 | 0 | 1 | 0 | 0/0 | - |
| `446E-r0rXHI` Go in 100 Seconds (Fireship) | mixed | no | classified | 1 | 0 | 2 | 1 | 1/1 | - |
| `8mAITcNt710` Harvard CS50 – Full Computer Science University Co | mixed | no | classified | 1 | 0 | 3 | 1 | 1/1 | - |
| `-DVyjdw4t9I` Guido van Rossum: Python and the Future of Program | code_mentioning | no | not_coding | 0 | 0 | 0 | 6 | 0/0 | - |
| `zjkBMFhNj_g` [1hr Talk] Intro to Large Language Models (Karpath | code_mentioning | no | not_coding | 0 | 0 | 0 | 8 | 0/0 | - |
| `aircAruvnKk` But what is a neural network? (3Blue1Brown) | code_mentioning | no | not_coding | 0 | 0 | 4 | 3 | 0/0 | - |
| `dQw4w9WgXcQ` Rick Astley - Never Gonna Give You Up | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `iG9CE55wbtY` Do schools kill creativity? | Sir Ken Robinson | T | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `UF8uR6Z6KLc` Steve Jobs' 2005 Stanford Commencement Address | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `arj7oStGLkU` Inside the Mind of a Master Procrastinator | Tim U | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `spUNpyF58BY` But what is the Fourier Transform? A visual introd | non_coding | no | not_coding | 0 | 0 | 0 | 5 | 0/0 | - |

## Misclassified sections

Labelled share = fraction of the section's time labelled as qualifying (>= 0.5 counts as qualifying).

| Video | Kind | Span (s) | Labelled share | Format | Confidence | Section title |
| --- | --- | --- | --- | --- | --- | --- |
| `W6NZfCO5SIk` | FN | 203-274 | 0.76 | code | high | Browser console hello world |
| `W6NZfCO5SIk` | FN | 466-582 | 0.88 | theory | medium | Where to place the script element |
| `W6NZfCO5SIk` | FN | 2387-2408 | 1.00 | theory | low | Functions introduction (start) |
| `eIrMbAQSU34` | FN | 2364-2400 | 1.00 | theory | low | Primitive variables and independent memory locations |
| `HXV3zeQKqGY` | FN | 1390-2400 | 1.00 | theory | low | Tables, primary keys, foreign keys and composite keys (conceptual) |
| `SqcY0GlETPk` | FN | 994-1211 | 0.67 | theory | medium | Virtual DOM, React DOM and library versus framework |
| `kCc8FmEb1nY` | FN | 469-511 | 0.74 | mixed | medium | Setting up Colab notebook and loading the dataset |
| `kCc8FmEb1nY` | FN | 660-767 | 1.00 | theory | high | Theory of subword tokenizers (SentencePiece, tiktoken, BPE) |
| `x7X9w_GIm1s` | FN | 0-145 | 0.52 | theory | low | Python overview |
| `446E-r0rXHI` | FN | 43-84 | 0.59 | code | high | Installing Go and creating a first program |
| `446E-r0rXHI` | FN | 126-151 | 0.58 | theory | medium | Concurrency with goroutines and closing outro |
| `8mAITcNt710` | FN | 305-830 | 0.90 | theory | medium | Computer science as problem solving and counting in binary |
| `8mAITcNt710` | FN | 830-1541 | 1.00 | theory | medium | Representing letters with ASCII and bytes |
| `8mAITcNt710` | FN | 1541-2161 | 1.00 | theory | medium | Representing colours, video and compression |
| `aircAruvnKk` | FN | 112-336 | 0.70 | theory | high | Network layers and activations overview |
| `aircAruvnKk` | FN | 336-531 | 1.00 | theory | high | Why layered structure might work |
| `aircAruvnKk` | FN | 531-807 | 1.00 | theory | medium | Weights, biases and sigmoid |
| `aircAruvnKk` | FN | 807-988 | 1.00 | theory | high | Matrix and vector notation for layers |
