# Planner eval: section "qualifies" precision / recall

Model `claude-haiku-5-5`, 26 labelled videos (`labels.json`, labelled from captions and storyboard frames). Regenerate with `python -m app.planner.evaluate run && python -m app.planner.evaluate score` from `backend/`.

| Metric | Value |
| --- | --- |
| Section precision (qualifies) | **0.918** (78 / 85; 95% lower bound 0.840) |
| Section recall (qualifies) | **0.876** (78 / 89) |
| Time-weighted precision | 0.935 |
| Time-weighted recall | 0.866 |
| Video verdict accuracy (coding vs not_coding) | 0.923 |
| Pauses inside labelled teaching, before a labelled answer | 0.987 (77 / 78) |

Bar: auto-pause turns on when section precision >= 0.9 in every run. Result: **met, auto-pause on**.

## Repeat runs (same labels, same captions)

| Run | Precision | Recall | Time precision | Time recall | Verdict accuracy | Pauses ok |
| --- | --- | --- | --- | --- | --- | --- |
| `results.json` | 0.918 | 0.876 | 0.935 | 0.866 | 0.923 | 0.987 |
| `results-run2.json` | 0.962 | 0.874 | 0.944 | 0.818 | 0.885 | 0.974 |

## Per video

| Video | Category | Labelled coding | Status | TP | FP | FN | TN | Pauses ok | Wrong pauses (s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `kqtD5dpn9C8` Python for Beginners - Learn Coding with Python in | tutorial | yes | classified | 10 | 0 | 0 | 2 | 7/7 | - |
| `ZDa-Z5JzLYM` Python OOP Tutorial 1: Classes and Instances (Core | tutorial | yes | classified | 5 | 0 | 1 | 1 | 3/3 | - |
| `W6NZfCO5SIk` JavaScript Course for Beginners (Mosh) | tutorial | yes | classified | 9 | 1 | 0 | 3 | 9/9 | - |
| `eIrMbAQSU34` Java Full Course for Beginners (Mosh) | tutorial | yes | classified | 7 | 1 | 0 | 5 | 7/7 | - |
| `vLnPwxZdW4Y` C++ Tutorial for Beginners - Full Course (Giraffe  | tutorial | yes | classified | 4 | 1 | 0 | 2 | 3/4 | 730 |
| `KJgsSFOSQv0` C Programming Tutorial for Beginners (Giraffe Acad | tutorial | yes | classified | 4 | 1 | 0 | 2 | 4/4 | - |
| `GhQdlIFylQ8` C# Tutorial - Full Course for Beginners (Giraffe A | tutorial | yes | classified | 4 | 1 | 0 | 1 | 5/5 | - |
| `HXV3zeQKqGY` SQL Tutorial - Full Database Course for Beginners | tutorial | yes | not_coding | 0 | 0 | 1 | 2 | 0/0 | - |
| `SqcY0GlETPk` React Tutorial for Beginners (Mosh) | tutorial | yes | classified | 7 | 1 | 2 | 5 | 7/7 | - |
| `rfscVS0vtbw` Learn Python - Full Course for Beginners (freeCode | tutorial | yes | classified | 4 | 1 | 0 | 2 | 7/7 | - |
| `kCc8FmEb1nY` Let's build GPT: from scratch, in code, spelled ou | tutorial | yes | classified | 6 | 0 | 0 | 2 | 7/7 | - |
| `0IAPZzGSbME` 1. Introduction to Algorithms (Abdul Bari) | theory | no | not_coding | 0 | 0 | 0 | 2 | 0/0 | - |
| `mB5HXBb_HY8` 2.7.2. Merge Sort Algorithm (Abdul Bari) | theory | yes | classified | 4 | 0 | 0 | 0 | 4/4 | - |
| `pTB0EiLXUC8` Object-Oriented Programming, Simplified (Mosh) | theory | yes | classified | 3 | 0 | 2 | 1 | 2/2 | - |
| `oBt53YbR9Kk` Dynamic Programming - Learn to Solve Algorithmic P | theory | yes | classified | 6 | 0 | 1 | 1 | 7/7 | - |
| `x7X9w_GIm1s` Python in 100 Seconds (Fireship) | mixed | yes | classified | 1 | 0 | 1 | 2 | 1/1 | - |
| `446E-r0rXHI` Go in 100 Seconds (Fireship) | mixed | yes | classified | 1 | 0 | 1 | 1 | 1/1 | - |
| `8mAITcNt710` Harvard CS50 – Full Computer Science University Co | mixed | yes | classified | 3 | 0 | 1 | 1 | 3/3 | - |
| `-DVyjdw4t9I` Guido van Rossum: Python and the Future of Program | code_mentioning | no | not_coding | 0 | 0 | 0 | 8 | 0/0 | - |
| `zjkBMFhNj_g` [1hr Talk] Intro to Large Language Models (Karpath | code_mentioning | no | not_coding | 0 | 0 | 0 | 5 | 0/0 | - |
| `aircAruvnKk` But what is a neural network? (3Blue1Brown) | code_mentioning | yes | not_coding | 0 | 0 | 1 | 2 | 0/0 | - |
| `dQw4w9WgXcQ` Rick Astley - Never Gonna Give You Up | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `iG9CE55wbtY` Do schools kill creativity? | Sir Ken Robinson | T | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `UF8uR6Z6KLc` Steve Jobs' 2005 Stanford Commencement Address | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `arj7oStGLkU` Inside the Mind of a Master Procrastinator | Tim U | non_coding | no | not_coding | 0 | 0 | 0 | 1 | 0/0 | - |
| `spUNpyF58BY` But what is the Fourier Transform? A visual introd | non_coding | no | not_coding | 0 | 0 | 0 | 3 | 0/0 | - |

## Misclassified sections

Labelled share = fraction of the section's time labelled as qualifying (>= 0.5 counts as qualifying).

| Video | Kind | Span (s) | Labelled share | Format | Confidence | Section title |
| --- | --- | --- | --- | --- | --- | --- |
| `ZDa-Z5JzLYM` | FN | 0-88 | 0.61 | theory | medium | Intro and why use classes |
| `W6NZfCO5SIk` | FP | 817-960 | 0.13 | code | medium | Running JavaScript with Node |
| `eIrMbAQSU34` | FP | 513-941 | 0.44 | code | high | Creating a project and writing Hello World |
| `vLnPwxZdW4Y` | FP | 530-753 | 0.00 | code | high | Creating a first project and running Hello World |
| `KJgsSFOSQv0` | FP | 552-775 | 0.00 | mixed | medium | Creating a console project and running Hello World |
| `GhQdlIFylQ8` | FP | 266-571 | 0.10 | mixed | medium | Reading the console app template |
| `HXV3zeQKqGY` | FN | 1390-2400 | 1.00 | theory | medium | Tables, primary/foreign/composite keys and table relationships |
| `SqcY0GlETPk` | FN | 549-700 | 0.66 | off_topic | medium | Tour of project files |
| `SqcY0GlETPk` | FN | 1016-1147 | 0.95 | theory | high | Virtual DOM and React DOM |
| `SqcY0GlETPk` | FP | 1274-1477 | 0.48 | code | high | Installing Bootstrap and creating a ListGroup component |
| `rfscVS0vtbw` | FP | 393-616 | 0.34 | code | high | Creating a PyCharm project and a hello world program |
| `pTB0EiLXUC8` | FN | 323-388 | 1.00 | theory | low | Polymorphism: replacing switch statements with object methods |
| `pTB0EiLXUC8` | FN | 388-410 | 1.00 | theory | high | Recap of the benefits of OOP |
| `oBt53YbR9Kk` | FN | 2321-2400 | 1.00 | theory | low | Introducing the grid traveller problem |
| `x7X9w_GIm1s` | FN | 108-129 | 1.00 | theory | medium | Paradigms and third-party ecosystem |
| `446E-r0rXHI` | FN | 126-151 | 0.58 | off_topic | high | Outro and channel call to action |
| `8mAITcNt710` | FN | 1564-2161 | 1.00 | theory | medium | Colors, pixels, video, and compression |
| `aircAruvnKk` | FN | 132-988 | 0.94 | theory | medium | Neural network structure: neurons, layers, weights, biases and sigmoid |
