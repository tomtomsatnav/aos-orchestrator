| task | passes/3 | pass^3 | mean new tokens | mean wall (s) |
|---|---|---|---|---|
| readme-usage | 0/3 | no | 0 | 900 |
| changelog-entry | 0/3 | no | 11915 | 326.5 |
| fix-add | 0/3 | no | 0 | 900 |
| add-slugify | 0/3 | no | 0 | 900 |
| **all** | 0% | 0% of tasks | 2979 | 756.6 |

NOTE: INVALID AS RELIABILITY NUMBERS. 9/12 trials hit the 900 s timeout and 2/12 ended blocked: the draft emitted verify:"human" criteria
(e.g. fenced-shell-block, title-kept) and the goal parks at "awaiting human confirmation"; the harness has no documented way to confirm them. See run notes.
