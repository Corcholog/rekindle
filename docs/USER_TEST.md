# User test workflow

Purpose: find out whether other people can install Rekindle, get a first useful suggestion, and keep using what it proposes. Three to five testers, one session each, about 45 minutes. **No session has been run yet; every result in this repository stays "not measured" until one has.**

## Who

- People who keep notes or write projects (Obsidian or plain Markdown) and can follow a README. Rekindle runs in English or Spanish (`LANGUAGE`); record which one each tester used, and the language of their notes. They are not asked to review the code.
- Each tester uses either a synthetic demo vault (`demo_vault_en/` or `demo_vault/`) or their own notes. Own notes stay on their machine: they are never copied, uploaded or pasted into this repository. Without cloud keys, nothing leaves their machine either.
- Before starting, tell them what is recorded (the counts below plus your notes on what they said) and that they can stop at any time.

## Session (about 45 minutes)

| Min | Step | Record |
|---|---|---|
| 0 | Hand over the repository link only. Say nothing about how to start. Start the stopwatch when they begin reading the README. | Machine (OS, RAM, GPU yes/no), model used, whether they used the demo vault |
| 0 to 20 | They install and start Rekindle following the README alone. Help only when they have been stuck for 5 minutes, and write down exactly what blocked them. | **Time to a running Rekindle**; every point where they got stuck or you helped |
| 20 to 30 | They clip the articles from `demo_vault/ARTICULOS_DEMO.md`, or three of their own links. | **Time to the first suggestion on screen** (stopwatch), whether it looked relevant |
| 30 to 40 | They go through **Sugerencias**: accept or discard each one, picking a reason when they discard. Ask them to think aloud. | Notable quotes; what they expected and did not get |
| 40 to 45 | Debrief: would you use this weekly? what would you change first? | Answers, in their words |

Then run `pnpm usertest:stats` on their machine (it reads only their local database).

## What is recorded

| Measure | Source | Notes |
|---|---|---|
| Time to a running Rekindle | stopwatch | includes model downloads; say if they were already installed |
| **Time to first suggestion** | stopwatch, cross-checked with `usertest:stats` ("first article to first suggestion") | |
| **Time to first accepted suggestion** | stopwatch | not taken from the database: the timestamps that would give it are written by two different clocks, so a difference can be off by the machine's UTC offset |
| **Suggestions accepted (%)** | `usertest:stats`: accepted / (accepted + discarded) | pending ones are left out; with so few suggestions per tester, report counts, not only a percentage |
| **Most common rejection reasons** | `usertest:stats`: the five reasons plus "sin motivo" | counts only, no text |
| Stuck points | your notes | the most useful output of the session |

Sample size warning: with 3 to 5 testers and a handful of suggestions each, these are anecdotes with counts, not statistics. Write "n testers, m suggestions" next to every number, and add the model each tester used, since quality depends strongly on it.

## What goes into the repository

Only the aggregated table below, filled in from real sessions, plus anonymized stuck points ("tester 2 could not find the `ollama pull` step"). Never: notes, article titles or URLs they clipped, screenshots of their vault, names or emails.

## Results

| Tester | Machine / model | Time to running | Time to first suggestion | Time to first accepted | Accepted / resolved | Discard reasons | Main stuck point |
|---|---|---|---|---|---|---|---|
| not measured | | | | | | | |

Summary: **not measured**.
