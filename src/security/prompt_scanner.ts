/**
 * prompt_scanner.ts — Phase 4: Prompt Leakage Detection
 *
 * Phase 4 additions (additive-only):
 *   • pushAlert() integration — every prompt scan finding creates a SecurityAlert.
 *   • evaluatePrompt() from policy_engine — blocks or warns per policy rules.
 *   • Structured findings emitted for LLM context injection.
 *
 * Core scanning logic is unchanged from Phase 3.
 */

import { pushAlert, makeAlert } from './alert_store';
import { evaluatePrompt } from './policy_engine';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptFinding {
    type: 'pii' | 'medical' | 'confidential' | 'secret';
    category: string;
    match: string;
    start: number;
    end: number;
    suggestion: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface PromptScanResult {
    isClean: boolean;
    findings: PromptFinding[];
    anonymizedPrompt: string;
    riskLevel: 'safe' | 'warning' | 'dangerous';
    summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern definitions (unchanged from Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

interface PromptPattern {
    name: string;
    regex: RegExp;
    type: PromptFinding['type'];
    category: string;
    severity: PromptFinding['severity'];
    replaceFn: (match: string, idx: number) => string;
}

const PROMPT_PATTERNS: PromptPattern[] = [
    // PII
    {
        name: 'Email',
        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
        type: 'pii', category: 'email', severity: 'high',
        replaceFn: (_m, i) => `EMAIL_${String(i).padStart(3, '0')}@redacted.com`
    },
    {
        name: 'Phone',
        regex: /\b(?:\+?1[-.\ ]?)?\(?\d{3}\)?[-.\ ]?\d{3}[-.\ ]?\d{4}\b/g,
        type: 'pii', category: 'phone', severity: 'high',
        replaceFn: (_m, i) => `PHONE_${String(i).padStart(3, '0')}`
    },
    {
        name: 'SSN',
        regex: /\b\d{3}[-\ ]\d{2}[-\ ]\d{4}\b/g,
        type: 'pii', category: 'ssn', severity: 'critical',
        replaceFn: () => `SSN_REDACTED`
    },
    {
        name: 'Credit Card',
        regex: /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g,
        type: 'pii', category: 'credit_card', severity: 'critical',
        replaceFn: () => `CC_REDACTED`
    },
    {
        name: 'Date of Birth',
        regex: /\b(?:born|dob|date\s*of\s*birth)\s*[:=]?\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/gi,
        type: 'pii', category: 'dob', severity: 'high',
        replaceFn: () => `DOB_REDACTED`
    },
    // Medical
    {
        name: 'Medical Diagnosis',
        regex: /\b(?:diagnosed?\s+with|diagnosis\s*[:=]?\s*)\s*[A-Za-z\s]{3,40}/gi,
        type: 'medical', category: 'diagnosis', severity: 'critical',
        replaceFn: () => `MEDICAL_DIAGNOSIS_REDACTED`
    },
    {
        name: 'Prescription',
        regex: /\b(?:prescription|prescribed|medication|rx)\s*[:=]?\s*[A-Za-z\s]{3,30}/gi,
        type: 'medical', category: 'prescription', severity: 'high',
        replaceFn: () => `PRESCRIPTION_REDACTED`
    },
    {
        name: 'Patient ID',
        regex: /\b(?:patient\s*(?:id|number|no))\s*[:=]?\s*[A-Za-z0-9\-]{4,20}/gi,
        type: 'medical', category: 'patient_id', severity: 'critical',
        replaceFn: (_m, i) => `PATIENT_${String(i).padStart(3, '0')}`
    },
    {
        name: 'ICD Code',
        regex: /\bICD[-\s]?\d{1,2}[-\s]?[A-Z]\d{1,2}(?:\.\d{1,2})?\b/gi,
        type: 'medical', category: 'icd_code', severity: 'high',
        replaceFn: () => `ICD_CODE_REDACTED`
    },
    // Secrets
    {
        name: 'API Key',
        regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
        type: 'secret', category: 'api_key', severity: 'critical',
        replaceFn: () => `API_KEY_REDACTED`
    },
    {
        name: 'Bearer Token',
        regex: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/g,
        type: 'secret', category: 'bearer_token', severity: 'critical',
        replaceFn: () => `BEARER_TOKEN_REDACTED`
    },
    {
        name: 'AWS Key',
        regex: /\bAKIA[0-9A-Z]{16}\b/g,
        type: 'secret', category: 'aws_key', severity: 'critical',
        replaceFn: () => `AWS_KEY_REDACTED`
    },
    // Confidential
    {
        name: 'Confidential Marker',
        regex: /\b(?:confidential|classified|top\s+secret|internal\s+only|restricted|proprietary)\b/gi,
        type: 'confidential', category: 'classification', severity: 'medium',
        replaceFn: (m) => `[${m.toUpperCase()}_CONTENT_REDACTED]`
    },
];

// ─────────────────────────────────────────────────────────────────────────────
// Name detection heuristic (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

const COMMON_WORDS = new Set([
    'the','and','for','are','but','not','you','all','can','her','was','one',
    'our','out','day','had','has','his','how','its','may','new','now','old',
    'see','way','who','did','get','let','say','she','too','use','this','that',
    'with','have','from','they','been','said','each','which','their','will',
    'other','about','many','then','them','would','make','like','time','just',
    'know','take','people','into','year','your','good','some','could','than',
    'first','call','after','water','Monday','Tuesday','Wednesday','Thursday',
    'Friday','Saturday','Sunday','January','February','March','April','June',
    'July','August','September','October','November','December','Data','The',
    'This','What','When','Where','Why','How','Please','Thank','Yes','No',
]);

function detectNames(text: string): PromptFinding[] {
    const findings: PromptFinding[] = [];
    const nameRegex = /\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,15})\b/g;
    let match: RegExpExecArray | null;
    let counter = 0;

    while ((match = nameRegex.exec(text)) !== null) {
        if (COMMON_WORDS.has(match[1]) || COMMON_WORDS.has(match[2])) { continue; }
        counter++;
        findings.push({
            type: 'pii',
            category: 'person_name',
            match: match[0],
            start: match.index,
            end: match.index + match[0].length,
            suggestion: `PERSON_${String(counter).padStart(3, '0')}`,
            severity: 'high'
        });
    }
    return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main scan function — Phase 4: now also pushes to alert_store
// ─────────────────────────────────────────────────────────────────────────────

export function scanPrompt(
    prompt: string,
    sourceLabel: string = '<prompt>',
    extensionPath?: string
): PromptScanResult {
    const findings: PromptFinding[] = [];
    let anonymized = prompt;
    let replacementCounter = 0;

    for (const pattern of PROMPT_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(prompt)) !== null) {
            replacementCounter++;
            const replacement = pattern.replaceFn(match[0], replacementCounter);
            findings.push({
                type: pattern.type,
                category: pattern.category,
                match: match[0],
                start: match.index,
                end: match.index + match[0].length,
                suggestion: replacement,
                severity: pattern.severity
            });
        }
    }

    findings.push(...detectNames(prompt));

    // Build anonymized version (replace end→start to preserve indices)
    const sortedFindings = [...findings].sort((a, b) => b.start - a.start);
    for (const f of sortedFindings) {
        anonymized = anonymized.substring(0, f.start) + f.suggestion + anonymized.substring(f.end);
    }

    // Risk level
    const hasCritical = findings.some(f => f.severity === 'critical');
    const hasHigh     = findings.some(f => f.severity === 'high');
    const riskLevel: PromptScanResult['riskLevel'] =
        hasCritical ? 'dangerous' : hasHigh || findings.length > 0 ? 'warning' : 'safe';

    const typeCounts = findings.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const parts: string[] = [];
    if (typeCounts.pii)          { parts.push(`${typeCounts.pii} PII`); }
    if (typeCounts.medical)      { parts.push(`${typeCounts.medical} medical`); }
    if (typeCounts.secret)       { parts.push(`${typeCounts.secret} secret`); }
    if (typeCounts.confidential) { parts.push(`${typeCounts.confidential} confidential`); }

    const summary = findings.length === 0
        ? 'Prompt appears clean — no sensitive data detected.'
        : `Found ${findings.length} sensitive item(s): ${parts.join(', ')}. Risk: ${riskLevel.toUpperCase()}.`;

    // ── Phase 4: push structured alert to alert_store ─────────────────────
    if (findings.length > 0) {
        const severity = hasCritical ? 'critical' : hasHigh ? 'high' : 'medium';

        const promptAlert = makeAlert(
            'Prompt leakage detected',
            severity,
            'prompt_leakage',
            sourceLabel,
            summary,
            { policyAction: hasCritical ? 'blocked' : 'warned' }
        );
        pushAlert(promptAlert);

        // Policy evaluation
        const decision = evaluatePrompt(hasCritical, hasHigh, findings.length, extensionPath);
        // Decision message surfaced in the VS Code UI by the caller (extension.ts)
        // to avoid a circular import with vscode module.
        (promptAlert as any)._policyMessage = decision?.message;
    }

    return { isClean: findings.length === 0, findings, anonymizedPrompt: anonymized, riskLevel, summary };
}
