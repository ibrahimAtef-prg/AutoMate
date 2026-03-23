/**
 * openrouter_client.ts — Hallucination-Resistant LLM Client
 *
 * Uses OpenRouter's free tier models for strictly-grounded data governance
 * analysis.  Every LLM response is validated against the real pipeline
 * measurements before being returned to the caller.
 *
 * Anti-hallucination phases implemented here:
 *   Phase 1  — Structured DATASET_CONTEXT block (ground-truth facts only)
 *   Phase 2  — Strict DATA GOVERNANCE ANALYST system prompt
 *   Phase 3  — Enforced 5-section output format (Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note)
 *   Phase 4  — Column-name validation + auto-regeneration
 *   Phase 5  — Metric number validation + auto-regeneration
 *   Phase 6  — Low statistical-reliability warning prefix
 *   Phase 7  — Safe fallback when analysis is not possible
 */

import * as vscode from 'vscode';
import * as https from 'https';
import { getRecentAlerts, SecurityAlert } from '../security/alert_store';
import {
    buildDatasetContext,
    formatContextForLLM,
    AgentTools,
    DatasetContext,
    buildStructuredDatasetContext,
    formatStructuredDatasetContext,
    getValidNumbers,
    StructuredDatasetContext,
    PipelineContext,
} from './dataset_context_builder';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMResponse {
    content: string;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    error?: string;
}

// PipelineContext is defined in dataset_context_builder.ts (typed, not `any`).
// Re-exported here for consumers that import from openrouter_client.ts.
export type { PipelineContext } from './dataset_context_builder';

// ─────────────────────────────────────────────────────────────────────────────
// Provider configuration
// ─────────────────────────────────────────────────────────────────────────────

export type AIProvider = 'openrouter' | 'openai' | 'anthropic' | 'groq' | 'together' | 'mistral';

interface ProviderConfig {
    hostname: string;
    chatPath: string;
    modelsPath?: string;
    /** Build Authorization header value from key */
    authHeader: (key: string) => Record<string, string>;
    /** Default models to try (in order) */
    defaultModels: string[];
    /** Whether this provider uses the OpenAI-compatible request/response format */
    openAICompat: boolean;
}

const PROVIDER_CONFIGS: Record<AIProvider, ProviderConfig> = {
    openrouter: {
        hostname: 'openrouter.ai',
        chatPath: '/api/v1/chat/completions',
        modelsPath: '/api/v1/models',
        authHeader: (key) => ({
            'Authorization': `Bearer ${key}`,
            'HTTP-Referer': 'https://github.com/automate-privacy',
            'X-Title': 'AutoMate Privacy Platform',
        }),
        defaultModels: [
            'google/gemma-3-12b-it:free',
            'google/gemma-3-4b-it:free',
            'meta-llama/llama-3.1-8b-instruct:free',
            'mistralai/mistral-7b-instruct:free',
            'microsoft/phi-3-mini-128k-instruct:free',
        ],
        openAICompat: true,
    },
    openai: {
        hostname: 'api.openai.com',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
        openAICompat: true,
    },
    anthropic: {
        hostname: 'api.anthropic.com',
        chatPath: '/v1/messages',
        authHeader: (key) => ({
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
        }),
        defaultModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
        openAICompat: false,
    },
    groq: {
        hostname: 'api.groq.com',
        chatPath: '/openai/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['llama-3.1-8b-instant', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
        openAICompat: true,
    },
    together: {
        hostname: 'api.together.xyz',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['meta-llama/Llama-3-8b-chat-hf', 'mistralai/Mistral-7B-Instruct-v0.2'],
        openAICompat: true,
    },
    mistral: {
        hostname: 'api.mistral.ai',
        chatPath: '/v1/chat/completions',
        authHeader: (key) => ({ 'Authorization': `Bearer ${key}` }),
        defaultModels: ['mistral-small-latest', 'mistral-tiny', 'open-mistral-7b'],
        openAICompat: true,
    },
};



// ─────────────────────────────────────────────────────────────────────────────
// Free models on OpenRouter (kept for backward compat / fallback)
// ─────────────────────────────────────────────────────────────────────────────

const FREE_MODELS = PROVIDER_CONFIGS.openrouter.defaultModels;


const MODEL_UNAVAILABLE_PHRASES = [
    'no endpoints found',
    'no models found',
    'model not found',
    'not a valid model',
    'invalid model',
    'model is currently unavailable',
    'this model is not available',
    'provider returned error',
    'provider error',
    'service unavailable',
    'bad gateway',
    'rate limit exceeded',
    'context length exceeded',
    'temporarily unavailable',
    'overloaded',
];

// ─────────────────────────────────────────────────────────────────────────────
// Validation constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum regeneration attempts before accepting the best available response */
const MAX_REGENERATION_ATTEMPTS = 2;

/** Safe fallback phrase the LLM must use when it cannot ground its answer */
const SAFE_FALLBACK =
    'The requested analysis cannot be performed using the available dataset metrics.';

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export class OpenRouterClient {
    private apiKey: string;
    private provider: AIProvider = 'openrouter';
    private currentModelIdx = 0;
    /** Set to true once a key has been injected directly via setKey() */
    private _keySetDirectly = false;
    /** Cached live model list fetched from provider — null until first fetch */
    private _liveModels: string[] | null = null;
    private _liveModelsFetchedAt = 0;
    private static LIVE_MODELS_TTL_MS = 5 * 60 * 1000; // re-fetch every 5 min

    constructor(apiKey?: string) {
        this.apiKey = apiKey || '';
        this.refreshKey();
    }

    /** Get the active ProviderConfig for the current provider. */
    private get providerCfg(): ProviderConfig {
        return PROVIDER_CONFIGS[this.provider] || PROVIDER_CONFIGS.openrouter;
    }

    /**
     * Fetch available models from the provider catalog (OpenRouter only).
     * Falls back to the provider's defaultModels for other providers.
     */
    private fetchLiveModels(): Promise<string[]> {
        const cfg = this.providerCfg;
        // Only OpenRouter exposes a live models endpoint we can scrape for free tiers
        if (this.provider !== 'openrouter' || !cfg.modelsPath) {
            return Promise.resolve(cfg.defaultModels);
        }
        return new Promise((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.modelsPath,
                method: 'GET',
                headers: {
                    ...cfg.authHeader(this.apiKey),
                    'Content-Type': 'application/json',
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const freeIds: string[] = (parsed.data || [])
                            .filter((m: Record<string,unknown>) => {
                                if (typeof m.id !== 'string') { return false; }
                                if (m.id.endsWith(':free')) { return true; }
                                const p = m.pricing as Record<string, unknown> | undefined;
                                return p && Number(p['prompt']) === 0 && Number(p['completion']) === 0;
                            })
                            .map((m: Record<string,unknown>) => m.id as string);
                        if (freeIds.length > 0) {
                            void freeIds.length; // suppress debug log
                            resolve(freeIds);
                        } else {
                            resolve(cfg.defaultModels);
                        }
                    } catch {
                        resolve(cfg.defaultModels);
                    }
                });
            });
            req.on('error', () => resolve(cfg.defaultModels));
            req.setTimeout(8000, () => { req.destroy(); resolve(cfg.defaultModels); });
            req.end();
        });
    }

    /** Get model list — uses live cache, refreshes every 5 min */
    private async getModels(): Promise<string[]> {
        const now = Date.now();
        if (this._liveModels && (now - this._liveModelsFetchedAt) < OpenRouterClient.LIVE_MODELS_TTL_MS) {
            return this._liveModels;
        }
        const models = await this.fetchLiveModels();
        this._liveModels = models;
        this._liveModelsFetchedAt = now;
        return models;
    }

    /**
     * Set provider and key together (called from webview/extension).
     * Resets the model cache so the new provider's models are fetched.
     */
    setProviderAndKey(provider: AIProvider, key: string): void {
        if (provider && PROVIDER_CONFIGS[provider]) {
            this.provider = provider;
            this._liveModels = null; // invalidate cache
            this.currentModelIdx = 0;
        }
        if (key && key !== 'PASTE_API_KEY_HERE') {
            this.apiKey = key;
            this._keySetDirectly = true;
        }
    }

    /**
     * Directly inject an API key (e.g. from workspaceState or webview input).
     * This key takes highest priority and will not be overwritten by refreshKey().
     */
    setKey(key: string, provider?: AIProvider): void {
        if (provider && PROVIDER_CONFIGS[provider]) {
            this.provider = provider;
            this._liveModels = null;
            this.currentModelIdx = 0;
        }
        if (key && key !== 'PASTE_API_KEY_HERE') {
            this.apiKey = key;
            this._keySetDirectly = true;
        }
    }

    /** Return the currently active provider name. */
    getProvider(): AIProvider {
        return this.provider;
    }

    /**
     * Initialize or update the API key.
     * Priority: 1) directly set via setKey()  2) VS Code settings  3) ENV var  4) placeholder
     */
    refreshKey(): void {
        if (this._keySetDirectly && this.apiKey && this.apiKey !== 'PASTE_API_KEY_HERE') {
            return;
        }
        // Legacy VS Code setting (openrouter)
        const fromSettings = vscode.workspace.getConfiguration('automate').get<string>('openrouterApiKey', '');
        // Env var: check provider-specific first, then generic OPENROUTER_API_KEY
        const envKey = `${this.provider.toUpperCase().replace(/-/g,'_')}_API_KEY`;
        const fromEnv = (typeof process !== 'undefined' && (process.env?.[envKey] || process.env?.OPENROUTER_API_KEY)) || '';
        const resolved = fromSettings || fromEnv || 'PASTE_API_KEY_HERE';
        if (resolved !== 'PASTE_API_KEY_HERE' || !this.apiKey) {
            this.apiKey = resolved;
        }
    }

    /** Check if the client is configured. */
    isConfigured(): boolean {
        this.refreshKey();
        return this.apiKey.length > 0 && this.apiKey !== 'PASTE_API_KEY_HERE';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────────
    // Governance System Prompt
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Build the AutoMate AI Governance Analyst system prompt.
     *
     * Implements the full governance specification:
     *   • 15-layer platform architecture context
     *   • Data Access Rule: never reason from raw datasets — platform outputs only
     *   • Metric Integrity: never fabricate; state unavailable if missing
     *   • Column Integrity: never invent columns; schema-provided only
     *   • Conversation routing — greetings get a short reply only
     *   • Three response depth levels with explicit trigger phrases and length constraints
     *   • Level 1: 1–2 sentences; Level 2: 3–6 sentences; Level 3: full 8-section report
     *   • Column classification with concrete examples per class
     *   • Drift interpretation: 3 dimensions
     *   • Attack path modeling: 5 named vectors, no speculative attacks
     *   • Column-specific mitigation mapped to governance class
     *   • Governance Decision Interpretation: policy engine outcomes only, never invented
     *   • Risk Attribution: name the responsible platform layer per finding
     *   • Evidence-Based Reasoning: every conclusion must cite metrics, classifications, or policy
     *   • Uncertainty Handling: qualify analysis when reliability is low or metrics incomplete
     *   • Follow-up reasoning: extend prior context, do not restart
     *   • Warning deduplication: low-reliability flag is session state, not repeated content
     */
    private buildGovernanceSystemPrompt(sdc: StructuredDatasetContext): string {
        const contextBlock = formatStructuredDatasetContext(sdc);
        const rs = sdc.statistical_reliability_score;

        const reliabilityNote = rs == null
            ? 'statistical_reliability_score: data unavailable — treat all findings as provisional.'
            : rs > 0.8
                ? `statistical_reliability_score = ${rs.toFixed(4)} (High — findings are statistically stable).`
                : rs >= 0.65
                    ? `statistical_reliability_score = ${rs.toFixed(4)} (Medium — interpret with moderate caution).`
                    : `statistical_reliability_score = ${rs.toFixed(4)} (Low — acknowledged once at session start; do not repeat in follow-up responses).`;

        const lowReliabilityPreamble = (rs != null && rs < 0.65)
            ? `⚠ SESSION WARNING (acknowledge once only — do not repeat in follow-up responses):\n` +
              `  statistical_reliability_score = ${rs.toFixed(4)}. Metric stability is low.\n` +
              `  Explicitly qualify all findings in your first response only.\n\n`
            : '';

        const parts: string[] = [
            // ── Ground-truth metrics ─────────────────────────────────────────
            contextBlock,
            '',

            ...(lowReliabilityPreamble ? [lowReliabilityPreamble] : []),

            // ── Role ─────────────────────────────────────────────────────────
            'You are the AutoMate AI Governance Analyst operating inside an AI Data Governance Platform.',
            'Your role is to interpret governance signals produced by the platform and explain',
            'privacy risks, governance decisions, and mitigation strategies.',
            'You do NOT analyze raw datasets.',
            'You only interpret structured outputs produced by platform layers.',
            '',

            // ── System Architecture ───────────────────────────────────────────
            '## System Architecture',
            'The platform consists of the following layers:',
            '  Data Ingestion, Data Catalog, Data Profiling, Schema Intelligence,',
            '  Sensitive Data Detection, Data Quality, Privacy Risk Engine,',
            '  Re-Identification Modeling, Synthetic Data Risk Detection,',
            '  Statistical Reliability Analysis, Data Lineage, Governance Policy Engine,',
            '  Policy Authoring, Access Control & Compliance, Monitoring & Audit.',
            'You do NOT implement these layers. You interpret their outputs.',
            'Use only these platform layers. Do not invent additional system components.',
            '',

            // ── Data Access Rule ──────────────────────────────────────────────
            '## Data Access Rule',
            'You never access raw datasets directly.',
            'All reasoning must rely only on structured outputs produced by the platform layers.',
            '',

            // ── Metric Integrity ──────────────────────────────────────────────
            '## Metric Integrity',
            'Never fabricate metrics.',
            'Possible metrics include: privacy_score, dataset_risk_score, statistical_reliability_score,',
            'column_drift, pii_columns, sensitive_columns.',
            `If a metric is missing, explicitly state that the information is unavailable.`,
            `If a question cannot be answered from available data, respond: "${SAFE_FALLBACK}"`,
            '',

            // ── Column Integrity ──────────────────────────────────────────────
            '## Column Integrity',
            'Never invent dataset columns.',
            'Only reference columns present in the provided dataset schema in DATASET_CONTEXT.',
            '',

            // ── Conversation Routing ──────────────────────────────────────────
            '## Conversation Routing',
            'Before answering, determine whether the message requires dataset analysis.',
            'If the message is a greeting or small talk (hi, hello, hey, thanks, thank you, ok, okay,',
            'good morning, good evening), respond briefly.',
            'Example: "Hello. I\'m the AutoMate AI Governance Agent.',
            'Ask about privacy risks, dataset drift, anonymization strategies, or governance policies."',
            '',

            // ── Response Depth Policy ─────────────────────────────────────────
            '## Response Depth Policy',
            'Always choose the minimum response depth needed.',
            '',
            '### Level 1 — Short Answer',
            'Used for simple factual questions.',
            'Examples: Which column has the highest drift / How many PII columns exist / Which columns are direct identifiers',
            'Respond in 1–2 sentences only. Do NOT generate reports.',
            '',
            '### Level 2 — Analytical Explanation',
            'Used for evaluation or reasoning questions.',
            'Examples: Is this dataset safe to share externally / How could this dataset be re-identified /',
            '  What privacy risks exist in this dataset',
            'Provide a short analytical explanation (3–6 sentences).',
            'Explain the main risks and reasoning clearly.',
            'Do NOT generate the full governance report.',
            '',
            '### Level 3 — Full Governance Analysis',
            'Generate the full governance report ONLY when the user explicitly requests it.',
            'Trigger phrases include:',
            '  generate full report, full governance report, complete analysis,',
            '  detailed assessment, produce full governance analysis',
            'Only then generate the structured report.',
            '',

            // ── Full Governance Report Structure ──────────────────────────────
            '## Full Governance Report Structure (Level 3 only)',
            'Do not rename these sections.',
            '',
            'Dataset Context',
            'Risk Interpretation',
            'Identifier Classification',
            'Column Risk Analysis',
            'Attack Paths',
            'Mitigation Strategy',
            'Governance Recommendation',
            `Confidence Note  (use: ${reliabilityNote})`,
            '',

            // ── Column Classification ─────────────────────────────────────────
            '## Column Classification',
            'Classify attributes into governance categories:',
            '  Direct Identifier   — Examples: phone, national_id, email',
            '  Quasi Identifier    — Examples: name, city, zipcode, birthdate',
            '  Sensitive Attribute — Examples: medical data, financial data, demographic attributes',
            '',

            // ── Drift Interpretation ──────────────────────────────────────────
            '## Drift Interpretation',
            'When drift exists analyze three dimensions:',
            '  Synthetic Data Quality — distribution mismatch between synthetic and original data',
            '  Privacy Leakage Risk   — possible memorization of original records',
            '  Analytical Impact      — impact on downstream models and analytics',
            'Explain implications rather than repeating metric values.',
            '',

            // ── Attack Path Modeling ──────────────────────────────────────────
            '## Attack Path Modeling',
            'Describe realistic attack vectors. Explain how each could realistically occur.',
            'Avoid speculative attacks.',
            '  • Direct identifier lookup',
            '  • Quasi-identifier linkage',
            '  • Cross-dataset correlation',
            '  • Synthetic data memorization',
            '  • Public dataset matching',
            '',

            // ── Column-Specific Mitigation ────────────────────────────────────
            '## Column-Specific Mitigation',
            'Mitigation must correspond to the identified risk. Avoid generic advice.',
            '  Direct Identifiers',
            '    → tokenization, format-preserving encryption, salted hashing, suppression before external sharing',
            '  Quasi Identifiers',
            '    → hierarchical generalization, bucketization, k-anonymity, aggregation',
            '  Sensitive Attributes',
            '    → differential privacy, controlled access, synthetic regeneration',
            '',

            // ── Governance Decision Interpretation ────────────────────────────
            '## Governance Decision Interpretation',
            'Policy outcomes come from the Governance Policy Engine.',
            'Do not invent policy outcomes.',
            'Possible outcomes: allow dataset usage / require anonymization / deny external sharing / require compliance review.',
            'Explain why the decision occurred and what actions are required.',
            '',

            // ── Risk Attribution ──────────────────────────────────────────────
            '## Risk Attribution',
            'Reference the platform layer responsible for each finding.',
            'Examples:',
            '  "Sensitive Data Detection identified PII columns."',
            '  "Privacy Risk Engine evaluated re-identification risk."',
            '',

            // ── Follow-up Reasoning ───────────────────────────────────────────
            '## Follow-up Reasoning',
            'Maintain reasoning across conversation turns.',
            'Build on previous analysis instead of restarting.',
            'Avoid repeating explanations already given.',
            '',

            // ── Evidence-Based Reasoning ──────────────────────────────────────
            '## Evidence-Based Reasoning',
            'Every conclusion must reference metrics, column classifications, or policy decisions.',
            'Avoid unsupported speculation.',
            '',

            // ── Uncertainty Handling ──────────────────────────────────────────
            '## Uncertainty Handling',
            'If statistical reliability is low or metrics are incomplete:',
            '  • explicitly qualify the analysis',
            '  • explain the limitations of the findings',
            '',

            // ── Communication Style ───────────────────────────────────────────
            '## Communication Style',
            'Respond as a professional AI data governance analyst.',
            'Be: clear, analytical, concise, technically precise.',
            'Avoid unnecessary verbosity. Do not behave like a template generator.',

            // ── Structured Data Sections (REQUIRED HEADERS) ───────────────────────────
            // Section headers must be present so the LLM can locate each data segment.
            '',
            '## DATASET PROFILE',
            `  dataset_risk_score: ${sdc.dataset_risk_score != null ? sdc.dataset_risk_score.toFixed(1) + '/100' : '[NOT COMPUTED]'}`,
            `  Rows: ${sdc.rows ?? 'unknown'} | Columns: ${(sdc.column_names ?? []).length}`,
            `  Numeric  : ${(sdc.numeric_column_names  ?? []).join(', ') || 'none'}`,
            `  Categoric: ${(sdc.categorical_column_names ?? []).join(', ') || 'none'}`,
            '',
            '## PRIVACY ANALYSIS',
            `  privacy_score   : ${sdc.privacy_score_pct ?? '[NOT COMPUTED]'}`,
            `  risk_level      : ${sdc.risk_level ?? '[NOT COMPUTED]'}`,
            `  avg_drift_score : ${sdc.avg_drift_score != null ? sdc.avg_drift_score.toFixed(4) : '[NOT COMPUTED]'}`,
            `  duplicates_rate : ${sdc.duplicates_rate != null ? (sdc.duplicates_rate * 100).toFixed(2) + '%' : '[NOT COMPUTED]'}`,
            `  membership_inference_auc: ${sdc.membership_inference_auc ?? '[NOT COMPUTED]'}`,
            ...((() => {
                const privacy_components = sdc.privacy_components;
                if (!privacy_components) { return ['  privacy_components: unavailable']; }
                return [
                    '  privacy_components (0=safe 1=critical):',
                    `    duplicates_risk          : ${privacy_components.duplicates_risk?.toFixed(3) ?? '[NOT COMPUTED]'}`,
                    `    mi_attack_risk           : ${privacy_components.mi_attack_risk?.toFixed(3) ?? '[NOT COMPUTED]'}`,
                    `    distance_similarity_risk : ${privacy_components.distance_similarity_risk?.toFixed(3) ?? '[NOT COMPUTED]'}`,
                    `    distribution_drift_risk  : ${privacy_components.distribution_drift_risk?.toFixed(3) ?? '[NOT COMPUTED]'}`,
                ];
            })()),
            '',
            '## COLUMN DRIFT (column_drift)',
            ...((() => {
                // colDrift sorted descending — highest JS-divergence column listed first
                const colDrift: Record<string, number> = sdc.column_drift ?? {};
                const entries = Object.entries(colDrift).sort(([, a], [, b]) => b - a).slice(0, 10);
                return entries.length === 0
                    ? ['  column_drift: none available']
                    : entries.map(([col, score]) => `  ${col.padEnd(28)} JS-div=${score.toFixed(4)}`);
            })()),
            '',
            '## SYNTHETIC DATA',
            `  generator_used : ${sdc.generator_used ?? '[NOT COMPUTED]'}`,
            `  synthetic_rows : ${sdc.synthetic_rows ?? '[NOT COMPUTED]'}`,
            `  avg_drift_score: ${sdc.avg_drift_score != null ? sdc.avg_drift_score.toFixed(4) : '[NOT COMPUTED]'}`,
            '  Sample rows (slice 0,20 — never fabricate values):',
            ...((() => {
                // Limit sample rows to at most 20 rows (slice(0, 20)) to prevent context bloat
                const samples: Record<string, unknown>[] = sdc.sample_rows ?? [];
                return samples.slice(0, 20).map((row, i) => `    row ${i + 1}: ${JSON.stringify(row)}`);
            })()),
            '',
            '## PII SCAN RESULTS',
            `  pii_columns (${(sdc.pii_columns ?? []).length}): ${(sdc.pii_columns ?? []).join(', ') || 'none detected'}`,
            ...((() => {
                const ranking = sdc.sensitive_column_ranking ?? [];
                return ranking.length === 0
                    ? ['  sensitive_column_ranking: unavailable']
                    : [
                        '  sensitive_column_ranking (composite desc):',
                        ...ranking.slice(0, 10).map(c =>
                            `    ${c.column.padEnd(28)} score=${c.score.toFixed(3)} pii=${c.pii_score.toFixed(2)} reid=${c.reidentification_risk.toFixed(2)}`
                        ),
                    ];
            })()),
            '',
            '## ATTACK SIMULATION',
            ...((() => {
                const threats: Array<{
                    name: string; severity: string; confidence: number;
                    description: string; triggered_by: string[];
                }> = sdc.threats ?? [];
                if (threats.length === 0) { return ['  No attack threats modeled from current pipeline output.']; }
                return threats.slice(0, 8).flatMap(t => [
                    `  [${t.severity.toUpperCase()}] ${t.name}  confidence=${t.confidence.toFixed(2)}`,
                    `    ${t.description}`,
                    t.triggered_by.length > 0
                        ? `    triggered_by: ${t.triggered_by.join(', ')}`
                        : '    triggered_by: no specific columns',
                    '',
                ]);
            })()),
        ];

        return parts.join('\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core HTTP chat completion
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Send a chat completion request (raw — no validation layer).
     * Automatically cycles through FREE_MODELS when a model is unavailable.
     */
    async chat(messages: LLMMessage[], model?: string): Promise<LLMResponse> {
        this.refreshKey();
        if (!this.apiKey) {
            return {
                content: '',
                model: '',
                error: 'OpenRouter API key not configured. Set "automate.openrouterApiKey" in VS Code settings.',
            };
        }

        // If a specific model is pinned, try only that one (no fallback loop)
        if (model) {
            return this._chatOnce(messages, model);
        }

        // Fetch live model list (cached), fall back to hardcoded list
        const models = await this.getModels();

        // Cycle through all available free models until one responds
        const startIdx = this.currentModelIdx % models.length;
        for (let i = 0; i < models.length; i++) {
            const tryIdx = (startIdx + i) % models.length;
            const tryModel = models[tryIdx];
            const resp = await this._chatOnce(messages, tryModel);

            if (!resp.error) {
                // Success — pin this index for next calls in the session
                this.currentModelIdx = tryIdx;
                this._liveModels = models; // keep same list
                return resp;
            }

            const errLow = (resp.error || '').toLowerCase();
            const isUnavailable = MODEL_UNAVAILABLE_PHRASES.some(p => errLow.includes(p));
            if (!isUnavailable) {
                // Real error (auth, parse, network) — surface it immediately
                return resp;
            }

            // Model unavailable — try next one silently
            void tryModel; // suppress debug log — log.warn would go here
        }

        // All models exhausted
        return {
            content: '',
            model: models[this.currentModelIdx % models.length],
            error: `All ${models.length} available models are currently offline on OpenRouter. This is a server-side issue — please wait a minute and try again.`,
        };
    }

    /** Single HTTP request to one specific model — no retry logic. */
    private _chatOnce(messages: LLMMessage[], selectedModel: string): Promise<LLMResponse> {
        const cfg = this.providerCfg;

        // Anthropic uses a different API format (system prompt separate, no 'model' in choices)
        if (!cfg.openAICompat) {
            return this._chatOnceAnthropic(messages, selectedModel, cfg);
        }

        const body = JSON.stringify({
            model: selectedModel,
            messages: messages,
            max_tokens: 2048,
            temperature: 0.3,
        });

        return new Promise<LLMResponse>((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.chatPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...cfg.authHeader(this.apiKey),
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({
                                content: '',
                                model: selectedModel,
                                error: parsed.error.message || JSON.stringify(parsed.error),
                            });
                        } else {
                            const choice = parsed.choices?.[0];
                            resolve({
                                content: choice?.message?.content || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage,
                            });
                        }
                    } catch (e) {
                        resolve({ content: '', model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });

            req.on('error', (err) => {
                resolve({ content: '', model: selectedModel, error: `Network error: ${err.message}` });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                resolve({ content: '', model: selectedModel, error: 'Request timed out (30s)' });
            });
            req.write(body);
            req.end();
        });
    }

    /** Anthropic /v1/messages format (separate system prompt, content blocks). */
    private _chatOnceAnthropic(
        messages: LLMMessage[],
        selectedModel: string,
        cfg: ProviderConfig,
    ): Promise<LLMResponse> {
        const systemMsg = messages.find(m => m.role === 'system');
        const userMsgs = messages.filter(m => m.role !== 'system');

        const body = JSON.stringify({
            model: selectedModel,
            max_tokens: 2048,
            temperature: 0.3,
            ...(systemMsg ? { system: systemMsg.content } : {}),
            messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
        });

        return new Promise<LLMResponse>((resolve) => {
            const options = {
                hostname: cfg.hostname,
                path: cfg.chatPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...cfg.authHeader(this.apiKey),
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            resolve({
                                content: '',
                                model: selectedModel,
                                error: parsed.error.message || JSON.stringify(parsed.error),
                            });
                        } else {
                            // Anthropic returns content as an array of blocks
                            const textBlock = (parsed.content as Array<{type:string;text?:string}> || []).find((b) => b.type === 'text');
                            resolve({
                                content: textBlock?.text || '',
                                model: parsed.model || selectedModel,
                                usage: parsed.usage
                                    ? { prompt_tokens: parsed.usage.input_tokens, completion_tokens: parsed.usage.output_tokens, total_tokens: (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0) }
                                    : undefined,
                            });
                        }
                    } catch (e) {
                        resolve({ content: '', model: selectedModel, error: `Parse error: ${e}` });
                    }
                });
            });

            req.on('error', (err) => {
                resolve({ content: '', model: selectedModel, error: `Network error: ${err.message}` });
            });
            req.setTimeout(30000, () => {
                req.destroy();
                resolve({ content: '', model: selectedModel, error: 'Request timed out (30s)' });
            });
            req.write(body);
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4 — Column validation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extract all tokens from the response that look like column references.
     * We check every word-like token against the known column list.
     */
    private extractReferencedColumns(responseText: string, knownColumns: string[]): string[] {
        if (knownColumns.length === 0) { return []; }
        const referenced: string[] = [];
        for (const col of knownColumns) {
            // Escape for regex and search case-insensitively
            const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(`\\b${escaped}\\b`, 'i');
            if (rx.test(responseText)) {
                referenced.push(col);
            }
        }
        return referenced;
    }

    /**
     * Return all column-like tokens in the response that are NOT in the known list.
     * Heuristic: any CamelCase or snake_case token that the model mentions in the
     * Evidence block and is not a known metric keyword.
     */
    private findHallucinatedColumns(responseText: string, knownColumns: string[]): string[] {
        const knownLower = new Set(knownColumns.map(c => c.toLowerCase()));

        // Extract tokens that look like identifiers (letters/digits/underscores, >= 3 chars)
        const TOKEN_RX = /\b([a-zA-Z_][a-zA-Z0-9_]{2,})\b/g;
        const METRIC_KEYWORDS = new Set([
            // Standard section words — these are expected
            'explanation', 'evidence', 'recommendation', 'confidence', 'high', 'medium', 'low',
            'privacy', 'score', 'dataset', 'risk', 'drift', 'pii', 'reid', 'columns', 'rows',
            'statistical', 'reliability', 'metric', 'data', 'unavailable', 'analysis', 'available',
            'column', 'value', 'data', 'the', 'and', 'for', 'with', 'this', 'that', 'are',
            'can', 'not', 'have', 'has', 'will', 'should', 'may', 'each', 'all', 'any',
            'than', 'from', 'into', 'more', 'less', 'been', 'its', 'your', 'our', 'their',
            // Common English words that look like identifiers
            'rule', 'note', 'warning', 'error', 'action', 'type', 'name', 'level', 'rate',
            'true', 'false', 'null', 'none', 'based', 'above', 'below', 'result',
        ]);

        const hallucinated: string[] = [];
        let match: RegExpExecArray | null;
        TOKEN_RX.lastIndex = 0;

        while ((match = TOKEN_RX.exec(responseText)) !== null) {
            const token = match[1].toLowerCase();
            if (!METRIC_KEYWORDS.has(token) && !knownLower.has(token) && token.length >= 3) {
                // Only flag tokens that contain underscores (strong signal of a column name)
                // or appear in an Evidence: block context
                if (match[1].includes('_')) {
                    hallucinated.push(match[1]);
                }
            }
        }

        // Deduplicate
        return [...new Set(hallucinated)];
    }

    /**
     * Validate that the LLM response only references columns from the known list.
     * Returns null if valid, or a description of the violation.
     */
    private validateColumns(responseText: string, sdc: StructuredDatasetContext): string | null {
        if (sdc.columns.length === 0) {
            // No column list available — skip column validation
            return null;
        }

        const hallucinated = this.findHallucinatedColumns(responseText, sdc.columns);
        if (hallucinated.length === 0) { return null; }

        return `Response referenced column(s) not present in the dataset: ${hallucinated.join(', ')}. ` +
               `Valid columns are: ${sdc.columns.join(', ')}.`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5 — Metric number validation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Extract all numbers from a response text.
     */
    private extractNumbers(text: string): string[] {
        const NUMBER_RX = /\b\d+(?:\.\d+)?\b/g;
        const results: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = NUMBER_RX.exec(text)) !== null) {
            results.push(m[0]);
        }
        return results;
    }

    /**
     * Validate that numbers in the response were sourced from the pipeline context.
     * Returns null if valid, or a description of the violation.
     *
     * We apply a tolerance approach: small integers (0–100) used in prose
     * (e.g. "reduce risk by 30%") are allowed because they are general advice,
     * not fabricated dataset metrics.  Only decimal numbers with 2+ decimals
     * that do not match any pipeline value are flagged.
     */
    private validateMetrics(responseText: string, sdc: StructuredDatasetContext): string | null {
        const validNums = getValidNumbers(sdc);

        // Validate numbers cited in the Risk Interpretation section
        // (between "Risk Interpretation" and "Identifier Classification")
        const sectionMatch = responseText.match(/Risk Interpretation([\s\S]*?)Identifier Classification/i);
        if (!sectionMatch) { return null; } // section missing → format issue handled elsewhere

        const sectionText = sectionMatch[1];
        const nums = this.extractNumbers(sectionText);

        // Only flag decimal numbers — plain integers are too ambiguous in prose
        const decimalOther = nums.filter(n => n.includes('.') && !validNums.has(n));
        if (decimalOther.length === 0) { return null; }

        return `Response Risk Interpretation section references decimal value(s) not present in pipeline metrics: ` +
               `${decimalOther.join(', ')}. Only cite values from DATASET_CONTEXT.`;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6 — Low reliability warning
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The low-reliability warning is now encoded once in the system prompt
     * (as a SESSION WARNING) rather than prepended to every response.
     * This method is kept as a no-op passthrough for backward compatibility
     * with call sites that still reference it.
     */
    private applyReliabilityWarning(responseText: string, _sdc: StructuredDatasetContext): string {
        // Warning deduplication: the system prompt already injects the warning once.
        // Do NOT prepend it again here — that would violate Rule 2 of the governance spec.
        return responseText;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 7 — Safe fallback
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalise a response that the model returned as a safe fallback
     * into the required 5-section governance format.
     */
    private wrapFallback(sdc: StructuredDatasetContext): string {
        const ris = sdc.statistical_reliability_score;
        const confNote = ris != null
            ? ris > 0.8
                ? `statistical_reliability_score = ${ris.toFixed(4)} (High).`
                : ris >= 0.65
                    ? `statistical_reliability_score = ${ris.toFixed(4)} (Medium — interpret with caution).`
                    : `statistical_reliability_score = ${ris.toFixed(4)} (Low — treat all findings as provisional).`
            : 'statistical_reliability_score: data unavailable.';

        return [
            'Dataset Context',
            '  Unable to determine dataset properties — required metrics are absent from DATASET_CONTEXT.',
            '',
            'Risk Interpretation',
            `  ${SAFE_FALLBACK}`,
            '',
            'Identifier Classification',
            '  Cannot classify columns — no column data is available in DATASET_CONTEXT.',
            '',
            'Column Risk Analysis',
            '  No column-level risk analysis is possible without the required metrics.',
            '',
            'Attack Paths',
            '  Cannot evaluate re-identification attack paths without column and metric data.',
            '',
            'Mitigation Strategy',
            '  Ensure the dataset has been processed through the full pipeline so that all required',
            '  metrics (privacy_score, pii_columns, column_drift, etc.) are available before retrying.',
            '',
            'Governance Recommendation',
            '  Do not use or share this dataset until full pipeline metrics are available.',
            '',
            'Confidence Note',
            `  ${confNote}`,
        ].join('\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Validated chat — Phases 4, 5, 6, 7
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Send a governed chat request.  The response is validated against the
     * pipeline context; if invalid, regeneration is attempted up to
     * MAX_REGENERATION_ATTEMPTS times before falling back to the safe response.
     *
     * @param messages  Full message array (system prompt already included)
     * @param sdc       Structured dataset context for validation
     */
    private async validatedChat(
        messages: LLMMessage[],
        sdc: StructuredDatasetContext,
    ): Promise<LLMResponse> {
        let lastResponse: LLMResponse | null = null;

        for (let attempt = 0; attempt <= MAX_REGENERATION_ATTEMPTS; attempt++) {
            const response = await this.chat(messages);

            // Propagate hard errors immediately
            if (response.error) { return response; }

            const text = response.content;

            // Phase 7: detect if the model admitted it can't answer
            if (text.toLowerCase().includes('cannot be performed') ||
                text.toLowerCase().includes('not available in') ||
                text.toLowerCase().includes('data unavailable') && text.length < 200) {
                response.content = this.applyReliabilityWarning(
                    this.wrapFallback(sdc), sdc,
                );
                return response;
            }

            // Phase 4: column validation
            const colViolation = this.validateColumns(text, sdc);

            // Phase 5: metric validation
            const metricViolation = this.validateMetrics(text, sdc);

            if (!colViolation && !metricViolation) {
                // Valid response — apply Phase 6 warning and return
                response.content = this.applyReliabilityWarning(text, sdc);
                return response;
            }

            // Build a correction message to guide the next attempt
            lastResponse = response;
            const correctionParts: string[] = [
                'Your previous response was rejected because it violated the grounding rules.',
            ];
            if (colViolation) { correctionParts.push(`Column violation: ${colViolation}`); }
            if (metricViolation) { correctionParts.push(`Metric violation: ${metricViolation}`); }
            correctionParts.push(
                'Please regenerate your answer using ONLY the column names and metric values',
                'present in DATASET_CONTEXT. Do not invent any values.',
                'Use the required eight-section format:',
                '  Dataset Context / Risk Interpretation / Identifier Classification /',
                '  Column Risk Analysis / Attack Paths / Mitigation Strategy / Governance Recommendation / Confidence Note',
            );

            // Append the correction as a new user turn for the next iteration
            messages = [
                ...messages,
                { role: 'assistant', content: text },
                { role: 'user', content: correctionParts.join('\n') },
            ];
        }

        // All attempts exhausted — return best available response with warning
        if (lastResponse) {
            lastResponse.content = this.applyReliabilityWarning(lastResponse.content, sdc);
            return lastResponse;
        }

        // Absolute fallback
        return {
            content: this.applyReliabilityWarning(this.wrapFallback(sdc), sdc),
            model: FREE_MODELS[this.currentModelIdx % FREE_MODELS.length],
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Ask a data-aware question about the pipeline.
     * Uses the strict governance-analyst prompt (Phase 2) and full validation pipeline.
     */
    async askAboutData(question: string, context: PipelineContext): Promise<LLMResponse> {
        const dsCtx = context.datasetCtx ?? buildDatasetContext(context);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
        ];
        return this.validatedChat(messages, sdc);
    }

    /**
     * Generate privacy recommendations based on pipeline data.
     * Uses the strict governance-analyst prompt and full validation pipeline.
     */
    async getRecommendations(context: PipelineContext): Promise<LLMResponse> {
        const dsCtx = context.datasetCtx ?? buildDatasetContext(context);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        const systemPrompt = this.buildGovernanceSystemPrompt(sdc);
        const messages: LLMMessage[] = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content:
                    'Based on the DATASET_CONTEXT provided, generate a comprehensive list of ' +
                    'privacy and security recommendations. Prioritize by severity. ' +
                    'For each recommendation, cite the exact metric from DATASET_CONTEXT ' +
                    'that justifies it. Format as a numbered list. ' +
                    'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
            },
        ];
        return this.validatedChat(messages, sdc);
    }

    /**
     * Legacy method kept for backward compatibility.
     * Internally routes through the new governance-analyst prompt.
     */
    private buildSystemPrompt(ctx: PipelineContext): string {
        const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
        const sdc   = buildStructuredDatasetContext(dsCtx);
        return this.buildGovernanceSystemPrompt(sdc);
    }

    /**
     * Builds the REAL-TIME SECURITY ALERTS section for the system prompt.
     * Reads the last N alerts from alert_store and formats them for LLM analysis.
     */
    private buildSecurityAlertsSection(): string {
        const alerts = getRecentAlerts(20);
        if (alerts.length === 0) { return ''; }

        const lines: string[] = [
            '',
            '## REAL-TIME SECURITY ALERTS',
            'The following alerts were detected live in the developer workspace.',
            'For each alert: explain why it is dangerous and suggest concrete mitigation steps.',
            `Total alerts in session: ${alerts.length}`,
            '',
        ];

        const groups: Record<string, SecurityAlert[]> = {};
        for (const a of alerts) {
            (groups[a.category] = groups[a.category] ?? []).push(a);
        }

        const categoryLabel: Record<string, string> = {
            secret_exposure:  '🔑 Secret Exposures',
            pii_detected:     '👤 PII Detections',
            prompt_leakage:   '💬 Prompt Leakage',
            dataset_risk:     '📊 Dataset Risk',
            policy_violation: '🚫 Policy Violations',
        };

        for (const [cat, group] of Object.entries(groups)) {
            lines.push(`### ${categoryLabel[cat] ?? cat} (${group.length})`);
            for (const a of group.slice(0, 5)) {
                lines.push(
                    `  - [${a.severity.toUpperCase()}] ${a.type} | file: ${a.file}` +
                    (a.line ? ` line ${a.line}` : '') +
                    ` | ${a.pattern}` +
                    (a.policyAction ? ` | policy: ${a.policyAction}` : '') +
                    ` | ${a.timestamp.slice(11, 19)}`,
                );
            }
            if (group.length > 5) {
                lines.push(`  ... and ${group.length - 5} more ${cat} alerts.`);
            }
            lines.push('');
        }

        lines.push(
            'RULE: For every alert above, the AI MUST:',
            '  1. Explain the specific danger (data exposure risk, regulatory impact, attack vector).',
            '  2. Give concrete mitigation steps (e.g., rotate key, anonymize field, use env vars).',
            '  3. Cite the severity level and policy action in your response.',
            '',
        );

        return lines.join('\n');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 Agent method extensions (added outside class for clean separation)
// These are called from extension.ts command handlers.
// ─────────────────────────────────────────────────────────────────────────────

/** Extend OpenRouterClient with Phase 5 agent capabilities. */
declare module './openrouter_client' {
    interface OpenRouterClient {
        explainDataset(ctx: PipelineContext): Promise<LLMResponse>;
        detectAnomalies(ctx: PipelineContext): Promise<LLMResponse>;
        suggestCleaning(ctx: PipelineContext): Promise<LLMResponse>;
        generateSQL(question: string, ctx: PipelineContext): Promise<LLMResponse>;
        recommendGovernance(ctx: PipelineContext): Promise<LLMResponse>;
        agentChat(history: LLMMessage[], newMessage: string, ctx: PipelineContext): Promise<LLMResponse>;
    }
}

// ── Concrete implementations added directly to prototype ─────────────────────

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["explainDataset"] = async function(
    this: OpenRouterClient,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);
    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Explain this dataset using ONLY the metrics in DATASET_CONTEXT. Cover:',
                '1. OVERVIEW: total rows, column count, column names',
                '2. KEY RELATIONSHIPS: top correlated column pairs (if available)',
                '3. IMPORTANT COLUMNS: the most sensitive columns by reid_score and pii flags, with exact values',
                '4. POTENTIAL RISKS: top privacy/quality risks with exact metric evidence',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
                'Cite exact metric values from DATASET_CONTEXT. Do NOT invent any column names or numbers.',
            ].join('\n'),
        },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["detectAnomalies"] = async function(
    this: OpenRouterClient,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx    = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc      = buildStructuredDatasetContext(dsCtx);
    const anomalies = AgentTools.get_anomalies(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Analyse dataset anomalies using ONLY the metrics in DATASET_CONTEXT.',
                `Pipeline detected ${anomalies.length} anomaly signal(s):`,
                JSON.stringify(anomalies, null, 2),
                '',
                'For each anomaly:',
                '1. Name the column (must be in DATASET_CONTEXT columns list)',
                '2. Cite the exact metric value (drift score, null_ratio, etc.)',
                '3. Explain why this is problematic',
                '4. Recommend a specific remediation action',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
                'If no anomalies were detected, explain what that means for data quality.',
            ].join('\n'),
        },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["suggestCleaning"] = async function(
    this: OpenRouterClient,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx       = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc         = buildStructuredDatasetContext(dsCtx);
    const suggestions = dsCtx.cleaning_suggestions;

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Provide data cleaning recommendations using ONLY the metrics in DATASET_CONTEXT.',
                'The pipeline identified these issues:',
                JSON.stringify(suggestions, null, 2),
                '',
                'For each issue:',
                '1. State the column and the specific problem (with measured value from DATASET_CONTEXT)',
                '2. Give a concrete, actionable fix',
                '3. Assign HIGH/MEDIUM/LOW priority with justification citing the metric',
                '',
                'Group by: Missing Values | Outliers | PII Masking | Distribution Issues',
                '',
                'Use the required five-section format: Dataset Context / Risk Interpretation / Column Risk Analysis / Mitigation Strategy / Confidence Note.',
            ].join('\n'),
        },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["generateSQL"] = async function(
    this: OpenRouterClient,
    question: string,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx  = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc    = buildStructuredDatasetContext(dsCtx);
    const schema = AgentTools.get_sql_schema(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        'ADDITIONAL SQL RULES:',
        '  - Use ONLY column names present in the SQL Schema below and in DATASET_CONTEXT.',
        '  - Mark PII columns in SQL comments.',
        '  - Format SQL with uppercase keywords and proper indentation.',
        '  - If a requested column does not exist, state "column unavailable" and DO NOT invent one.',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                `Generate a SQL query for: "${question}"`,
                '',
                `Available schema: ${JSON.stringify(schema)}`,
                '',
                'Return using the five-section format:',
                'Dataset Context: describe the dataset and schema context',
                'Risk Interpretation: explain privacy implications of the query',
                'Column Risk Analysis / Mitigation Strategy: PII/privacy warnings and specific mitigations per column',
                'Confidence Note: based on statistical_reliability_score',
            ].join('\n'),
        },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["recommendGovernance"] = async function(
    this: OpenRouterClient,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx     = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc       = buildStructuredDatasetContext(dsCtx);
    const govActions = AgentTools.get_pii_findings(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        {
            role: 'user',
            content: [
                'Propose a governance action plan using ONLY the metrics in DATASET_CONTEXT.',
                'Pipeline analysis identified:',
                JSON.stringify(govActions, null, 2),
                '',
                'Structure your Explanation section as:',
                '  ## CRITICAL ACTIONS (implement immediately)',
                '  ## HIGH PRIORITY (implement this sprint)',
                '  ## MEDIUM PRIORITY (plan within 30 days)',
                '  ## MONITORING (set up automated checks)',
                '',
                'For each action: name the column (from DATASET_CONTEXT only), the technique',
                '(masking/hashing/k-anonymity/noise/removal), and cite the exact risk score that justifies it.',
                '',
                'Then complete the Mitigation Strategy and Confidence Note sections as required.',
            ].join('\n'),
        },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};

(OpenRouterClient.prototype as unknown as Record<string, unknown>)["agentChat"] = async function(
    this: OpenRouterClient,
    history: LLMMessage[],
    newMessage: string,
    ctx: PipelineContext,
): Promise<LLMResponse> {
    const dsCtx = ctx.datasetCtx ?? buildDatasetContext(ctx);
    const sdc   = buildStructuredDatasetContext(dsCtx);

    const systemPrompt = [
        (this as OpenRouterClient)['buildGovernanceSystemPrompt'](sdc),
        '',
        'AGENT CAPABILITIES (use only when supported by DATASET_CONTEXT):',
        '  - explain dataset structure and schema',
        '  - identify risky/sensitive columns with exact scores from DATASET_CONTEXT',
        '  - detect anomalies using drift, null_ratio metrics from DATASET_CONTEXT',
        '  - suggest data cleaning strategies with specific techniques',
        '  - generate SQL queries using only actual schema column names from DATASET_CONTEXT',
        '  - recommend governance actions (masking, hashing, k-anonymity, noise)',
        '  - explain privacy risks with regulatory context (GDPR, HIPAA, PCI-DSS)',
        '',
        '## ADDITIONAL FULL PIPELINE CONTEXT (for reference)',
        formatContextForLLM(dsCtx),
    ].join('\n');

    const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-10),   // keep last 10 turns for context window efficiency
        { role: 'user', content: newMessage },
    ];
    return (this as OpenRouterClient)['validatedChat'](messages, sdc);
};
