"use strict";
/**
 * policy_engine.ts — Phase 4 Policy Enforcement Engine
 *
 * Reads policy.yaml (or falls back to hardcoded defaults) and maps each
 * security pattern match → enforcement action (block / warn / log).
 *
 * Design rules:
 *  - NEVER breaks if policy.yaml is missing or malformed.
 *  - All actions are additive: block always implies warn + log.
 *  - Public API is synchronous to keep the hot scanner path fast.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.refreshPolicy = refreshPolicy;
exports.evaluate = evaluate;
exports.evaluateDataset = evaluateDataset;
exports.evaluatePrompt = evaluatePrompt;
exports.getThresholds = getThresholds;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─────────────────────────────────────────────────────────────────────────────
// Built-in defaults (used when policy.yaml is absent)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_POLICY = {
    rules: {
        block_private_keys: { enabled: true, action: 'block', severity: 'critical', description: 'Private keys must never appear in workspace.' },
        block_aws_keys: { enabled: true, action: 'block', severity: 'critical', description: 'AWS Access Key IDs expose cloud credentials.' },
        block_credit_cards: { enabled: true, action: 'block', severity: 'critical', description: 'Credit card numbers are PCI-DSS regulated.' },
        block_connection_strings: { enabled: true, action: 'block', severity: 'high', description: 'Connection strings may embed credentials.' },
        warn_on_api_keys: { enabled: true, action: 'warn', severity: 'high', description: 'Hard-coded API keys violate secret management.' },
        warn_on_openai_keys: { enabled: true, action: 'warn', severity: 'high', description: 'OpenAI keys expose paid-API access.' },
        warn_on_jwt: { enabled: true, action: 'warn', severity: 'high', description: 'JWT tokens grant protected service access.' },
        warn_on_password: { enabled: true, action: 'warn', severity: 'high', description: 'Hardcoded passwords violate security policy.' },
        warn_on_bearer_token: { enabled: true, action: 'warn', severity: 'high', description: 'Bearer tokens grant delegated API access.' },
        warn_on_github_token: { enabled: true, action: 'warn', severity: 'high', description: 'GitHub tokens expose repository access.' },
        warn_on_ssn: { enabled: true, action: 'block', severity: 'critical', description: 'SSNs are the highest-risk PII category.' },
        warn_on_email: { enabled: true, action: 'warn', severity: 'medium', description: 'Email addresses may indicate PII exposure.' },
        warn_on_prompt_pii: { enabled: true, action: 'warn', severity: 'medium', description: 'PII in LLM prompt — anonymize before sending.' },
        warn_on_prompt_secrets: { enabled: true, action: 'block', severity: 'critical', description: 'Secrets in LLM prompts risk third-party exposure.' },
        warn_on_prompt_medical: { enabled: true, action: 'warn', severity: 'high', description: 'Medical data in prompts may violate HIPAA.' },
        warn_on_high_risk_dataset: { enabled: true, action: 'warn', severity: 'high', description: 'High-risk dataset requires privacy review.' },
        log_dataset_open: { enabled: true, action: 'log', severity: 'low', description: 'Dataset file opened — logged for audit.' },
    },
    thresholds: {
        pii_density_warn: 0.40,
        pii_density_block: 0.70,
        dataset_risk_score_warn: 60,
        prompt_pii_max_items: 0,
    },
};
// ─────────────────────────────────────────────────────────────────────────────
// Pattern → ruleId mapping
// Maps the pattern name from realtime_scanner to the relevant policy rule key.
// ─────────────────────────────────────────────────────────────────────────────
const PATTERN_TO_RULE = {
    'OpenAI API Key': 'warn_on_openai_keys',
    'GitHub Token': 'warn_on_github_token',
    'AWS Access Key': 'block_aws_keys',
    'Generic API Key Assignment': 'warn_on_api_keys',
    'JWT Token': 'warn_on_jwt',
    'Private Key': 'block_private_keys',
    'Password Assignment': 'warn_on_password',
    'Bearer Token': 'warn_on_bearer_token',
    'Connection String': 'block_connection_strings',
    'Email Address': 'warn_on_email',
    'SSN Pattern': 'warn_on_ssn',
    'Credit Card': 'block_credit_cards',
};
// ─────────────────────────────────────────────────────────────────────────────
// Policy loader
// ─────────────────────────────────────────────────────────────────────────────
let _policy = DEFAULT_POLICY;
let _policyLoadedAt = 0;
const POLICY_TTL_MS = 30_000; // reload at most every 30 s
function findPolicyFile(extensionPath) {
    // Check workspace root first, then extension dir
    const candidates = [];
    const wsRoots = vscode.workspace.workspaceFolders?.map(w => w.uri.fsPath) ?? [];
    for (const root of wsRoots) {
        candidates.push(path.join(root, 'policy.yaml'));
    }
    if (extensionPath) {
        candidates.push(path.join(extensionPath, 'policy.yaml'));
    }
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}
/**
 * Simple YAML→object parser for the limited policy.yaml schema.
 * Avoids pulling in a YAML dependency — handles only key: value pairs
 * and nested sections separated by blank lines.
 */
function parseSimpleYaml(text) {
    const result = {};
    let section = null;
    let subSection = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) {
            continue;
        }
        // Detect top-level key (no leading spaces)
        const topMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (topMatch) {
            section = topMatch[1];
            subSection = null;
            if (topMatch[2].trim()) {
                result[section] = coerce(topMatch[2].trim());
            }
            else {
                result[section] = result[section] ?? {};
            }
            continue;
        }
        // Detect 2-space indented key (sub-section)
        const sub2Match = line.match(/^  ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (sub2Match && section) {
            subSection = sub2Match[1];
            if (typeof result[section] !== 'object') {
                result[section] = {};
            }
            if (sub2Match[2].trim()) {
                result[section][subSection] = coerce(sub2Match[2].trim());
            }
            else {
                result[section][subSection] = result[section][subSection] ?? {};
            }
            continue;
        }
        // Detect 4-space indented key (leaf values)
        const leaf4Match = line.match(/^    ([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
        if (leaf4Match && section && subSection) {
            const key = leaf4Match[1];
            const val = coerce(leaf4Match[2].trim());
            if (typeof result[section][subSection] !== 'object') {
                result[section][subSection] = {};
            }
            result[section][subSection][key] = val;
        }
    }
    return result;
}
function coerce(v) {
    if (v === 'true') {
        return true;
    }
    if (v === 'false') {
        return false;
    }
    const n = Number(v);
    if (!isNaN(n) && v !== '') {
        return n;
    }
    // Strip surrounding quotes
    return v.replace(/^["']|["']$/g, '');
}
function buildPolicyFromYaml(raw) {
    const rules = { ...DEFAULT_POLICY.rules };
    const rawRules = raw['rules'] ?? {};
    for (const [id, ruleRaw] of Object.entries(rawRules)) {
        if (!ruleRaw || typeof ruleRaw !== 'object') {
            continue;
        }
        const r = ruleRaw;
        rules[id] = {
            enabled: r['enabled'] ?? true,
            action: (r['action'] ?? 'warn'),
            severity: (r['severity'] ?? 'medium'),
            description: r['description'] ?? '',
        };
    }
    const rawThr = raw['thresholds'] ?? {};
    const thresholds = {
        pii_density_warn: Number(rawThr['pii_density_warn'] ?? DEFAULT_POLICY.thresholds.pii_density_warn),
        pii_density_block: Number(rawThr['pii_density_block'] ?? DEFAULT_POLICY.thresholds.pii_density_block),
        dataset_risk_score_warn: Number(rawThr['dataset_risk_score_warn'] ?? DEFAULT_POLICY.thresholds.dataset_risk_score_warn),
        prompt_pii_max_items: Number(rawThr['prompt_pii_max_items'] ?? DEFAULT_POLICY.thresholds.prompt_pii_max_items),
    };
    return { rules, thresholds };
}
function loadPolicy(extensionPath) {
    const now = Date.now();
    if (now - _policyLoadedAt < POLICY_TTL_MS) {
        return _policy;
    }
    _policyLoadedAt = now;
    const filePath = findPolicyFile(extensionPath);
    if (!filePath) {
        return DEFAULT_POLICY;
    }
    try {
        const text = fs.readFileSync(filePath, 'utf-8');
        const raw = parseSimpleYaml(text);
        _policy = buildPolicyFromYaml(raw);
    }
    catch {
        _policy = DEFAULT_POLICY; // graceful fallback
    }
    return _policy;
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/** Reload the policy immediately (bypasses TTL cache). */
function refreshPolicy(extensionPath) {
    _policyLoadedAt = 0;
    loadPolicy(extensionPath);
}
/**
 * Evaluate what action should be taken for a detected pattern.
 *
 * @param patternName  The `name` field from SECURITY_PATTERNS in realtime_scanner
 * @param extensionPath  Extension root (for locating policy.yaml)
 * @returns PolicyDecision or null if the rule is disabled.
 */
function evaluate(patternName, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const ruleId = PATTERN_TO_RULE[patternName];
    if (!ruleId) {
        return null;
    }
    const rule = policy.rules[ruleId];
    if (!rule || !rule.enabled) {
        return null;
    }
    const emoji = rule.action === 'block' ? '❌' : rule.action === 'warn' ? '⚠' : 'ℹ';
    const label = rule.action === 'block' ? 'blocked by policy' : rule.action === 'warn' ? 'policy warning' : 'logged by policy';
    return {
        action: rule.action,
        severity: rule.severity,
        ruleId,
        message: `${emoji} ${patternName} — ${label}: ${rule.description}`,
    };
}
/**
 * Evaluate a dataset risk result against thresholds.
 * Returns a PolicyDecision or null if no threshold is breached.
 */
function evaluateDataset(piiDensity, riskScore, extensionPath) {
    const policy = loadPolicy(extensionPath);
    const thr = policy.thresholds;
    if (piiDensity >= thr.pii_density_block) {
        return {
            action: 'block',
            severity: 'critical',
            ruleId: 'warn_on_high_risk_dataset',
            message: `❌ Dataset PII density ${(piiDensity * 100).toFixed(0)}% exceeds block threshold — blocked by policy`,
        };
    }
    if (piiDensity >= thr.pii_density_warn || riskScore >= thr.dataset_risk_score_warn) {
        const rule = policy.rules['warn_on_high_risk_dataset'];
        if (!rule?.enabled) {
            return null;
        }
        return {
            action: 'warn',
            severity: 'high',
            ruleId: 'warn_on_high_risk_dataset',
            message: `⚠ Dataset risk score ${riskScore.toFixed(0)}/100 — policy warning: review before use`,
        };
    }
    return null;
}
/**
 * Evaluate a prompt scan result.
 * Returns a PolicyDecision or null if clean.
 */
function evaluatePrompt(hasCritical, hasHigh, itemCount, extensionPath) {
    const policy = loadPolicy(extensionPath);
    if (hasCritical) {
        const rule = policy.rules['warn_on_prompt_secrets'];
        if (rule?.enabled) {
            return {
                action: 'block',
                severity: 'critical',
                ruleId: 'warn_on_prompt_secrets',
                message: `❌ Secrets detected in LLM prompt — blocked by policy: ${rule.description}`,
            };
        }
    }
    if (hasHigh || itemCount > policy.thresholds.prompt_pii_max_items) {
        const rule = policy.rules['warn_on_prompt_pii'];
        if (rule?.enabled) {
            return {
                action: 'warn',
                severity: 'medium',
                ruleId: 'warn_on_prompt_pii',
                message: `⚠ ${itemCount} sensitive item(s) in LLM prompt — policy warning: ${rule.description}`,
            };
        }
    }
    return null;
}
/** Expose thresholds (for dataset monitor). */
function getThresholds(extensionPath) {
    return loadPolicy(extensionPath).thresholds;
}
//# sourceMappingURL=policy_engine.js.map