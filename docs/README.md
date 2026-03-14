
<div align="center">

<br/>

```
   ___        __           __  ___      __
  / _ | __ __/ /____  ____/  |/  /___ _/ /____
 / __ |/ // / __/ _ \/ __/ /|_/ / _ `/ __/ -_)
/_/ |_|\_,_/\__/\___/_/ /_/  /_/\_,_/\__/\__/
```

### **VS Code Extension for ML Engineers & Data Scientists**

<br/>

[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.108.0-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.9%2B-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org/)
[![Webpack](https://img.shields.io/badge/Webpack-5.x-8DD6F9?style=flat-square&logo=webpack&logoColor=black)](https://webpack.js.org/)
[![Status](https://img.shields.io/badge/Status-In%20Development-orange?style=flat-square)]()
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

<br/>

> Detects dataset imports inline, builds statistical baselines, generates privacy-safe synthetic data
> using auto-selected engines, validates through a 3-stage pipeline, and monitors generation live —
> **all without leaving your editor.**

<br/>

[Origin](#-origin) · [Features](#-features) · [How It Works](#-how-it-works) · [Installation](#-installation) · [Usage](#-usage) · [Architecture](#-architecture) · [API](#-api-reference) · [Team](#-team)

<br/>

</div>

---

## 🗒️ Origin

This is where it all started.

<div align="center">
  <img src="docs/assets/IDE_Extension_Planning_s0.png" alt="Original planning whiteboard — Auto Mate first design session" width="100%"/>
  <br/>
  <sub>The original flow diagram from our first design session — before a single line of code was written.</sub>
</div>

<br/>

The whiteboard laid out three core flows that became the backbone of the project:

**Flow 1 — Error Fix & Syntax Check**
The early idea was to detect errors inline, send them to an AI model for syntax checking, produce a fix recommendation, and replace the broken code with the corrected version. This evolved into the CodeLens + baseline pipeline — rather than fixing code, we shifted toward fixing the *data* that the code depends on.

**Flow 2 — Synthetic Data Generation**
This one survived almost intact. The sketch described taking a CSV, passing it through a GAN to produce new rows with the same labels but different feature distributions, then appending the generated data back into the original dataset. The final implementation generalises this into three engine tiers (Statistical, Gaussian Copula, CTGAN) with a full validation layer before any row is accepted.

**Flow 3 — Data Leakage Detection**
The sketch outlined a true/false leakage detector with an AI model for auto-fix, covering nulls, misplaced values, mislabelled samples, duplicates, and normalization. In the final build this became the three-stage `ValidationLayer` — `ConstraintFilter`, `RowQualityFilter`, and `DuplicatePreFilter` — running on every generated batch before it is committed to the checkpoint.

**UX Flow (top right of the sketch)**
The sketch drew a clear inside/outside boundary for the IDE and identified four UX steps: error fix, synthetic data gen, leakage detection, and fix recommendations — feeding into a "full clean" output. The Checkpoint Monitor panel is the direct descendant of that "full clean" output concept.

A lot changed between that whiteboard and the final implementation — the GAN became three auto-selected engines, the AI fix panel became a statistical validation layer, and the output became an atomic crash-safe checkpoint file. But every major piece of the final system is visible in that first sketch.

---

## 🧩 Features

| | Feature | Description |
|---|---|---|
| 🔍 | **CodeLens Detection** | Spots `pd.read_csv`, `read_excel`, `read_json`, `read_parquet`, `spark.read` inline and places a button above the line |
| 📊 | **Dataset Parser** | Extracts schema, types, null ratios, sample values, and a SHA-256 fingerprint for any CSV, Excel, JSON, or Parquet file |
| 🧠 | **Behavioral Baseline** | Builds a full statistical contract — quantile profiles, IQR, Pearson, Cramér's V, point-biserial, constraints, and auto-generated rules |
| ⚗️ | **Synthetic Generator** | Three engines auto-selected by dataset size: Statistical (< 1k rows), Gaussian Copula (1k–50k), CTGAN (50k+) |
| ✅ | **Validation Pipeline** | Three-stage gate: constraint repair → quality filter → exact deduplication via SHA-256 row hashing |
| 📡 | **Live Monitor** | Checkpoint panel polls every 2s — progress bar, per-round table, warnings, and sample rows in real time |

---

## ⚙️ How It Works

Auto Mate orchestrates a **TypeScript VS Code extension** and a **Python data pipeline**. The two layers talk through `child_process.spawn` — the extension spawns Python scripts and reads their JSON output. No server, no network, no API keys. Everything runs locally.

```
Your Python file
       │
       │  pd.read_csv("train.csv")   ← CodeLens appears here
       ▼
  parse.py      →  schema, preview, SHA-256 fingerprint
       │
       ▼
  baseline.py   →  quantile profiles, correlations, constraints, rule set
       │
       ▼
  generator.py  →  engine selection → label-first sampling → synthetic rows
       │
       ▼
  validation.py →  ConstraintFilter → RowQualityFilter → DuplicatePreFilter
       │
       ▼
  checkp.py     →  atomic checkpoint → VS Code monitor polls every 2s
```

### Engine Selection

The generator reads the baseline's row count and routes automatically:

| Dataset Size | Engine | Strategy |
|---|---|---|
| < 1,000 rows | **StatisticalEngine** | Quantile-CDF inverse sampling + Cholesky copula |
| 1,000 – 50,000 rows | **ProbabilisticEngine** | Gaussian copula — empirical CDF → probit → MVN → Q⁻¹ |
| ≥ 50,000 rows | **CTGANEngine** | CTGAN (falls back to Probabilistic if `ctgan` not installed) |

All three engines support **label-first generation** — when a target column is detected (highest total point-biserial association with numeric features), the engine samples class labels first, then draws each feature from per-class conditional distributions.

### Validation — Three Stages

Every batch of generated rows passes three independent gates before being committed:

```
Raw batch
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 1 — ConstraintFilter                 │
│  Numeric ranges + categorical allowed values │
│  Violations: resample-retry, never clip      │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│  Stage 2 — RowQualityFilter                 │
│  A: IQR outer fence  (Tukey 3×)             │
│  B: Mahalanobis distance (chi² p=0.99)      │
│  C: Conditional label plausibility (4σ)     │
│  > max_failures checks → drop row           │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│  Stage 3 — DuplicatePreFilter               │
│  SHA-256 hash each row vs original dataset  │
│  Exact match → drop row                     │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
              Accepted rows → CheckPoint
```

---

## 🚀 Installation

### Prerequisites

| Tool | Version | Required for |
|---|---|---|
| VS Code | `^1.108.0` | Extension host |
| Node.js | `18+` | Build & bundling |
| Python | `3.9+` | Data pipeline |
| pandas | `>=1.5` | Parsing & baseline |
| numpy | `>=1.23` | Generator math |
| scipy | `>=1.9` | Gaussian copula |
| openpyxl | `>=3.0` | Excel support |
| pyarrow | `>=10.0` | Parquet support |

### Install from Source

```bash
# 1. Clone the repository
git clone https://github.com/NNA-team/automate.git
cd automate

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies
pip install -r requirements.txt

# 4. Compile the extension
npm run compile

# 5. Open in VS Code and press F5 to launch
code .
```

### Optional — CTGAN (large datasets ≥ 50,000 rows)

```bash
pip install ctgan
```

If `ctgan` is not installed, the extension falls back to `ProbabilisticEngine` automatically with a warning.

---

## 🛠️ Usage

### 1 — Analyse a Dataset

Open any `.py` file that loads data with pandas. A **"Parse Dataset (IDE Lense)"** button will appear inline above the import line.

```python
# The CodeLens appears above this line ↓
df = pd.read_csv("data/train.csv")
```

Click it — Auto Mate runs `parse.py` + `baseline.py` and opens a panel showing the full schema, statistical profile, correlations, and auto-generated validation rules.

### 2 — Generate Synthetic Data

In the Parse + Baseline panel, set the number of rows and click **Generate**. The Checkpoint Monitor opens immediately and shows live progress. Once complete, the first 20 rows are previewed and the full output is saved to `.idelense/cache/`.

### 3 — Configure Python Path

If `python3` is not in your `PATH`:

```json
// .vscode/settings.json
{
  "idelense.pythonPath": "/usr/bin/python3"
}
```

### Commands

| Command | Description |
|---|---|
| `IDE Lense: Analyse Dataset` | Run parse + baseline on the detected dataset |
| `IDE Lense: Generate Synthetic Data` | Prompt to use the CodeLens |
| `IDE Lense: Open Checkpoint Monitor` | Open the live generation monitor |

---

## 🏗️ Architecture

```
src/
├── extension.ts          VS Code entry — CodeLens, commands, webviews
└── utils/
    ├── parse.py          Dataset AST parser (CSV / Excel / JSON / Parquet / SQL)
    ├── baseline.py       Behavioral baseline builder
    ├── generator.py      Three-engine synthetic data generator
    ├── validation.py     Three-stage validation layer
    └── checkp.py         Atomic checkpoint store & agent interface

docs/
├── architecture.md       Full system diagrams and module breakdown
├── api.md                Python API reference for all five modules
└── features/
    ├── synthetic-data.md
    ├── data-leakage.md
    ├── dataset-explorer.md
    └── checkpoint-monitor.md

planning/
├── roadmap.md            Five-phase project roadmap
└── sprints.md            Sprint-by-sprint task breakdown

.github/
├── ISSUE_TEMPLATE/       Bug report + feature request forms
└── PULL_REQUEST_TEMPLATE.md
```

For the full architecture with data flow diagrams, see [`docs/architecture.md`](docs/architecture.md).

---

## 📖 API Reference

All five Python scripts can be run directly from the command line:

```bash
# Parse a dataset
python src/utils/parse.py data/train.csv --sample-rows 100

# Build a baseline
python src/utils/baseline.py data/train.csv --kind csv

# Generate synthetic data
python src/utils/generator.py data/train.csv cache/baseline.json \
  --n 500 --cache-dir .idelense/cache --seed 42
```

Full API documentation — parameters, return types, data classes, checkpoint file format — is in [`docs/api.md`](docs/api.md).

---

## 📦 Supported Formats

| Format | Extensions | Parser |
|---|---|---|
| CSV / TSV | `.csv` `.tsv` | pandas (auto-delimiter) + stdlib fallback |
| Excel | `.xlsx` `.xlsm` | openpyxl |
| JSON / JSONL | `.json` `.jsonl` | json + pandas, nested flattening |
| Parquet | `.parquet` | pandas + pyarrow |
| SQL | `.sql` or inline text | sqlparse + regex fallback |

---

## 👥 Team

**NNA Team** — Helwan International Technological University, AI Department
**Supervisor:** *(to be filled)*

| # | Name | ID |
|---|---|---|
| 1 | Ibrahim Atef Mohamed Abdelfattah *(Leader)* | 2430404 |
| 2 | Ahmed Thrawat Mohamed Abdullah | 2430410 |
| 3 | Zeinab Mohamed Galal Morsy | 2430496 |
| 4 | Sara El-Sayed Mohamed Ibrahim | 2430497 |
| 5 | Somaya Alaa Abdelhalim Abdelaziz | 2430510 |
| 6 | Shorouk Magdy Esmat Ahmed Mohamed | 2430514 |
| 7 | Shereen Mohamed Ramadan Mohamed | 2430518 |
| 8 | Abdel-Rahman Mohamed Fahmy Abdel-Aal | 2430534 |
| 9 | Abdel-Rahman Farah Ahmed | 2430544 |
| 10 | Abdel-Rahman Mostafa Nabil Abdou Ahmed | 2430535 |
| 11 | Omar Ahmed Nady Mohamed Abdel-Salam | 2430565 |
| 12 | Omar Ayman Abdel-Aziz Abu El-Aal Farag | 2430566 |
| 13 | Mohamed Ahmed Mohamed Abdel-Aal El-Sayed | 2430601 |
| 14 | Malak Ihab Abdelhamid Abdelrahman | 2430665 |
| 15 | Mohamed Abdel-Nabi Mohamed Hammad | 2430615 |

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branching strategy, commit conventions (`feat/fix/docs/chore`), and PR process.

Quick start:

```bash
git checkout dev
git pull origin dev
git checkout -b feature/your-feature-name
```

Never push directly to `main` or `dev`. Always open a PR against `dev`.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">
<sub>Built at Helwan International Technological University · AI Department · 2nd Year Final Project</sub>
</div>
