# AutoMate

**AI-powered Data Governance Agent for privacy risk analysis, re-identification modeling, and policy-driven compliance insights.**

---

## Overview

Organizations working with sensitive datasets face growing pressure to understand privacy exposure, enforce governance policies, and demonstrate regulatory compliance — without slowing down data operations.

AutoMate solves this by combining a structured, multi-layer governance platform with an LLM explanation layer. The platform computes dataset metrics, detects PII, models re-identification risk, and evaluates governance policies. The AI Governance Analyst then interprets those outputs and delivers clear, actionable governance insights to developers, data engineers, and compliance teams.

AutoMate does not expose raw data to the LLM. All reasoning is performed against structured platform outputs.

---

## Key Features

- **Dataset Governance Analysis** — end-to-end privacy and risk assessment across dataset attributes
- **Privacy Risk Interpretation** — explains privacy scores, risk levels, and statistical reliability in plain language
- **Re-identification Attack Path Modeling** — identifies realistic attack vectors including quasi-identifier linkage, cross-dataset correlation, and synthetic data memorization
- **Mitigation Strategy Recommendations** — column-specific techniques such as tokenization, k-anonymity, differential privacy, and format-preserving encryption
- **Policy Decision Interpretation** — explains Governance Policy Engine outcomes including allow, deny, and compliance review decisions
- **Conversational Analysis Interface** — supports natural dialogue at three response depths: short answers, analytical explanations, and full governance reports
- **Multi-provider LLM Support** — works with OpenRouter, OpenAI, Anthropic, Groq, Together AI, and Mistral

---

## Architecture

```
Dataset
  → Platform Layers (metrics, risk, policy)
  → Structured Outputs (metrics, classifications, policy decisions)
  → AI Governance Analyst (LLM Explanation Layer)
  → Human-readable governance insights
```

### Platform Layers

| # | Layer | Responsibility |
|---|-------|---------------|
| 1 | **Data Ingestion** | Collects datasets from databases, lakes, APIs, files, and streams |
| 2 | **Data Catalog** | Indexes schemas, metadata, and dataset ownership |
| 3 | **Data Profiling** | Computes distributions, cardinality, null rates, and data types |
| 4 | **Schema Intelligence** | Detects semantic meaning of columns and identifiers |
| 5 | **Sensitive Data Detection** | Identifies PII and sensitive attributes |
| 6 | **Data Quality** | Detects duplicates, schema drift, inconsistencies, and missing values |
| 7 | **Privacy Risk Engine** | Evaluates privacy exposure and re-identification risk scores |
| 8 | **Re-Identification Modeling** | Analyzes attribute combinations that could identify individuals |
| 9 | **Synthetic Data Risk Detection** | Detects memorization and privacy leakage in generated datasets |
| 10 | **Statistical Reliability Analysis** | Measures confidence and stability of dataset metrics |
| 11 | **Data Lineage** | Tracks dataset origins, transformations, and downstream usage |
| 12 | **Governance Policy Engine** | Evaluates governance rules and produces policy decisions |
| 13 | **Policy Authoring** | Defines sharing restrictions, anonymization requirements, and access policies |
| 14 | **Access Control & Compliance** | Enforces regulatory frameworks such as GDPR |
| 15 | **Monitoring & Audit** | Tracks usage events, policy violations, and governance decisions |

> The LLM interprets the structured outputs of these layers. It does not process raw datasets directly.

---

## How It Works

1. **Platform analysis** — the governance layers analyze the dataset and produce structured metrics, classifications, and policy decisions
2. **Metric injection** — outputs such as `privacy_score`, `column_drift`, `pii_columns`, and policy outcomes are passed to the AI Governance Analyst
3. **LLM interpretation** — the Analyst interprets the findings, classifies columns into governance categories (Direct Identifier, Quasi Identifier, Sensitive Attribute), models attack paths, and generates mitigation strategies
4. **Governance insight delivery** — the user receives a response calibrated to their question: a short factual answer, an analytical explanation, or a full structured governance report

---

## Example Interaction

```
User:  Which column has the highest re-identification risk?

Agent: The `national_id` column carries the highest re-identification risk.
       It is classified as a Direct Identifier by the Sensitive Data Detection layer
       and has a reid_score of 0.94, indicating near-certain individual identification
       from this attribute alone.
```

```
User:  Generate a full governance report for this dataset.

Agent:
  Dataset Context
    1,200 rows · 9 columns · High sensitivity (privacy_score = 0.31)

  Risk Interpretation
    The Privacy Risk Engine flagged elevated re-identification exposure.
    Statistical reliability is medium (0.74) — findings are moderately stable.

  Identifier Classification
    Direct Identifiers:   national_id, email
    Quasi Identifiers:    city, birthdate, gender
    Sensitive Attributes: income, medical_flag

  Column Risk Analysis
    national_id — reid_score 0.94. Unique across dataset. Immediate exposure risk.
    email       — direct linkage to public identity graphs.
    city + birthdate + gender — quasi-identifier combination. High linkage risk.

  Attack Paths
    1. Direct identifier lookup via national_id
    2. Quasi-identifier linkage: city × birthdate × gender narrows to ~3 individuals per group
    3. Cross-dataset correlation with public voter or health records

  Mitigation Strategy
    national_id  → irreversible salted hashing before any sharing
    email        → format-preserving tokenization
    city         → hierarchical generalization to region level
    birthdate    → age-band generalization (e.g. 5-year buckets)
    income       → Laplace noise injection (differential privacy ε = 1.0)

  Governance Recommendation
    Governance Policy Engine decision: deny external sharing.
    Required actions: apply Direct Identifier suppression and enforce k-anonymity (k ≥ 5)
    before reclassification for external release.

  Confidence Note
    statistical_reliability_score = 0.74 (Medium — interpret with moderate caution).
```

---

## Project Structure

```
automate/
├── src/
│   ├── ai/
│   │   ├── openrouter_client.ts      # Multi-provider LLM client + governance system prompt
│   │   ├── agent.ts                  # Agent chat logic and conversation management
│   │   └── dataset_context_builder.ts
│   ├── webview/
│   │   └── ui/
│   │       ├── agent.ts              # Webview UI — provider selector, chat interface
│   │       └── charts.ts             # Dashboard styles and visualizations
│   ├── security/
│   │   ├── prompt_scanner.ts
│   │   ├── realtime_scanner.ts
│   │   └── alert_store.ts
│   ├── utils/
│   │   ├── baseline.py
│   │   ├── risk_intelligence.py
│   │   └── validation.py
│   └── extension.ts                  # VS Code extension entry point
├── docs/
│   └── features/
├── package.json
└── tsconfig.json
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- Python ≥ 3.10
- An API key for a supported LLM provider

### Installation

```bash
git clone https://github.com/your-org/automate.git
cd automate
npm install
pip install -r requirements.txt
```

### Running the Extension

```bash
npm run compile
```

Then open the project in VS Code and press `F5` to launch the extension development host.

---

## Configuration

AutoMate supports multiple LLM providers. Set your API key through the in-app provider selector or via environment variables:

| Provider | Environment Variable |
|----------|---------------------|
| OpenRouter | `OPENROUTER_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |

Keys can also be entered directly in the AI Insights panel. They are stored per-provider in VS Code workspace state and persist across sessions.

---

## Roadmap

- [ ] Automated GDPR and HIPAA compliance evaluation
- [ ] Governance policy engine with configurable rule authoring
- [ ] Expanded re-identification risk modeling (l-diversity, t-closeness)
- [ ] Dataset lineage visualization
- [ ] Batch governance reporting across multiple datasets
- [ ] Integration with enterprise data catalog APIs (Collibra, Alation, Datahub)
- [ ] Audit log export for compliance documentation

---

## Contributing

Contributions are welcome. To contribute:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "feat: description"`
4. Push to your branch: `git push origin feature/your-feature`
5. Open a pull request against `main`

Please follow the existing code style and include relevant tests. For significant changes, open an issue first to discuss the proposed approach.

---

## License

This project is licensed under the [MIT License](LICENSE).
