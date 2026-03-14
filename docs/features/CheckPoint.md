# 📡 Checkpoint Monitor

## What It Does

The Checkpoint Monitor is a live VS Code panel that shows you exactly what is happening during synthetic data generation — round by round, row by row, in real time. It opens automatically when you click Generate and keeps updating until the run finishes.

No Python process is needed for the monitoring itself. The panel reads the checkpoint JSON file directly from disk every 2 seconds using `fs.readFileSync` — lightweight, crash-safe, and works even if the generator process is interrupted mid-run.

---

## How It Works

When generation starts, `generator.py` creates a checkpoint file at:

```
.idelense/cache/<fingerprint>_checkpoint.json
```

Every time a batch of rows passes the validation layer, `checkp.py` commits them to this file atomically. The VS Code panel polls the file on a 2-second interval and re-renders the entire UI from whatever is on disk at that moment.

```
generator.py
     │
     │  ValidationLayer.run() → accepted rows
     │
     ▼
CheckPoint.commit()
     │
     │  os.replace() → atomic write to disk
     │
     ▼
checkpoint.json  ◄──── VS Code panel reads every 2s
                              │
                              ▼
                       Re-renders UI
```

The polling loop stops automatically in two cases:
- The checkpoint status changes from `in_progress` to `complete` or `failed`
- The user closes the monitor panel

---

## The Panel — What You See

### Header

```
Engine: probabilistic  |  Status: ●complete  |  Rows: 500 / 500
```

- **Engine** — which of the three engines was used for this run
- **Status badge** — color-coded current state
- **Rows** — accepted rows committed so far out of the total requested

### Progress Bar

A visual percentage bar that fills as rows are committed. Updates every 2 seconds while the run is active.

### Per-Round Commit Table

One row per commit — every time the generator completes a round and passes rows through the validation layer, a new entry appears:

| Column | Description |
|---|---|
| `#` | Commit number (1-based, monotonically increasing) |
| `Round` | Generator retry-loop round that produced this batch |
| `Rows Added` | New accepted rows in this commit |
| `Total` | Cumulative accepted rows after this commit |
| `Rejected (Quality)` | Rows dropped by `RowQualityFilter` this round |
| `Rejected (Dedup)` | Rows dropped by `DuplicatePreFilter` this round |
| `Repaired` | Cells repaired by `ConstraintFilter` this round |
| `Time` | UTC timestamp of this commit |

### Warnings

Any warnings emitted during generation are listed here — engine selection reasoning, fallback notices, constraint repair counts, duplicate ratio warnings, and partial output notices if the full row count wasn't reached.

Example warnings:
```
Engine selected: probabilistic (dataset rows: 4200, requested samples: 500).
Probabilistic model fitted and cached.
Label column detected ('target'): per-class copulas fitted for label-first generation.
ConstraintFilter: repaired 3 out-of-range / invalid-category cells via resample-retry.
RowQualityFilter: rejected 12/600 rows (2.0%) — statistical plausibility checks failed.
```

### Sample Rows

The first 20 accepted rows are shown as formatted JSON at the bottom of the panel. This lets you verify the generated data looks reasonable before using it.

### Checkpoint Path

The full path to the checkpoint file is shown at the very bottom — useful for loading the full output programmatically.

---

## Status Badges

| Status | Color | Meaning |
|---|---|---|
| `in_progress` | 🟠 Orange | Generation is actively running |
| `complete` | 🟢 Green | All rows generated, checkpoint sealed |
| `failed` | 🔴 Red | Generation ended with an unrecoverable error |

A `complete` status with fewer rows than requested is still `complete` — it means the retry loop exhausted all 8 rounds without reaching the target. The partial output is preserved and a warning explains the shortfall.

---

## Checkpoint File Format

The checkpoint file is plain JSON — readable, debuggable, and safe to inspect at any point during or after a run.

```json
{
  "schema_version": "1.0",
  "dataset_fingerprint": "abc123def456...",
  "generator_used": "probabilistic",
  "n_requested": 500,
  "created_at": "2025-01-01T00:00:00Z",
  "updated_at": "2025-01-01T00:00:04Z",
  "status": "complete",
  "final_warnings": [
    "Engine selected: probabilistic (dataset rows: 4200, requested samples: 500).",
    "Probabilistic model loaded from cache."
  ],
  "commits": [
    {
      "commit_id": 1,
      "round": 0,
      "n_rows": 420,
      "cumulative": 420,
      "committed_at": "2025-01-01T00:00:02Z",
      "validation": {
        "n_evaluated": 500,
        "n_accepted": 420,
        "n_rejected_quality": 58,
        "n_rejected_duplicates": 22,
        "n_repaired_constraints": 7
      }
    },
    {
      "commit_id": 2,
      "round": 1,
      "n_rows": 80,
      "cumulative": 500,
      "committed_at": "2025-01-01T00:00:04Z",
      "validation": {
        "n_evaluated": 105,
        "n_accepted": 80,
        "n_rejected_quality": 18,
        "n_rejected_duplicates": 7,
        "n_repaired_constraints": 2
      }
    }
  ],
  "rows": [
    {"age": 34, "income": 52000, "gender": "F", "target": 1},
    {"age": 41, "income": 78000, "gender": "M", "target": 0},
    ...
  ]
}
```

---

## Atomic Writes — Crash Safety

Every write to the checkpoint file uses `os.replace()`:

```python
# Write to a temp file first
fd, tmp = tempfile.mkstemp(dir=cache_dir, suffix=".tmp")
with os.fdopen(fd, "w") as f:
    json.dump(data, f)

# Atomic rename — replaces the checkpoint in one OS operation
os.replace(tmp, checkpoint_path)
```

On POSIX systems (Linux, macOS) `os.replace()` is guaranteed atomic — the checkpoint is either the full previous version or the full new version, never a partially written file. A crash mid-write leaves the previous checkpoint intact and readable.

---

## Python Agent Interface

The checkpoint file can be read from any Python process — not just the generator. This is designed for background agents or scripts that need to poll generation progress without spawning the extension.

```python
from checkp import CheckPoint

# Bind to an existing checkpoint file
cp = CheckPoint.from_path(".idelense/cache/abc123_checkpoint.json")

# Lightweight status — does NOT load the row store
status = cp.status()
print(f"Status:   {status.status}")
print(f"Progress: {status.n_collected} / {status.n_requested} rows")
print(f"Engine:   {status.generator_used}")
print(f"Done:     {status.is_complete}")

# Full row export — only call when complete
if status.is_complete:
    rows = cp.export()
    print(f"Got {len(rows)} rows")

# Per-round commit metadata
commits = cp.export_commits()
for c in commits:
    print(f"Round {c.round}: +{c.n_rows} rows → {c.cumulative} total")
```

`status()` reads only the header and commits array — it does not load the `rows` array. This keeps polling cheap even when the checkpoint contains thousands of rows.

---

## Cache Directory

The checkpoint file and all model cache files are stored in:

```
<workspace>/.idelense/cache/
```

This directory is created automatically when generation starts. It is excluded from Git via `.gitignore` — model cache files are large and dataset-specific, and checkpoint files contain generated data that should not be version-controlled.

Files in this directory:

| File | Description |
|---|---|
| `<fingerprint>_checkpoint.json` | Per-run row store and progress record |
| `<fingerprint>_probabilistic.pkl` | Cached ProbabilisticEngine model |
| `<fingerprint>_ctgan.pkl` | Cached CTGANEngine model |

The fingerprint is the SHA-256 hash of the original dataset file, truncated to 32 characters. If the dataset file changes, the fingerprint changes and a fresh model is trained automatically.
