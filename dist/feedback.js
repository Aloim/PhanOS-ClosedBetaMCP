// cyphor-role: CORE
// phanos_feedback (C1 section 18): the input and output schemas, the section 5.4 limits and the send logic.
// Pure over injected deps: it reads no file, no environment and no network itself. `api.ts` imports the types
// below with `import type` (erased at runtime), so the only runtime edge is this file -> api.ts (ApiError).
import * as z from 'zod/v4';
import { ApiError } from './api.js';
export const FEEDBACK_TOOL_NAME = 'phanos_feedback';
export const FEEDBACK_TOOL_DESCRIPTION = 'Send a feedback or bug report to the PhanOS team, linked to your signed-in PhanOS account. Sends only what is passed in; reads no files itself.';
export const FEEDBACK_LIMITS = { maxFiles: 12, maxFileBytes: 262_144, maxTotalFileBytes: 1_048_576, maxBodyBytes: 1_572_864 };
export const FEEDBACK_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const short = z.string().min(1).max(64);
/**
 * No count or byte limit on `files` here (F-13316): a breach of the advertised schema is refused by the SDK before
 * the handler runs, so the section 5.4 limits live in `checkFeedbackLimits` and answer a structured `too_large`.
 */
export const feedbackInputSchema = z
    .object({
    category: z.enum(['bug', 'feedback']),
    title: z.string().trim().min(1).max(120),
    happened: z.string().min(1).max(8000),
    expected: z.string().max(8000).optional(),
    steps: z.string().max(8000).optional(),
    versions: z.object({ app: short.optional(), daemon: short.optional(), claudeCode: short.optional(), phanos: short.optional() }).strict().optional(),
    os: z.object({ platform: short, release: short, arch: short }).strict().optional(),
    files: z
        .array(z.object({ name: z.string().regex(FEEDBACK_FILE_NAME), content: z.string() }).strict())
        .refine((files) => new Set(files.map((f) => f.name)).size === files.length, { message: 'file names are unique' })
        .optional(),
    source: z.enum(['phanos-ui', 'claude-code']).default('claude-code'),
})
    .strict();
/** The codes this MCP can produce; `mcp_*`, `timeout` and `bundle_missing` belong to the UI daemon. */
export const FEEDBACK_MCP_CODES = ['invalid_request', 'unauthenticated', 'too_large', 'rate_limited', 'server', 'network', 'not_signed_in'];
export const feedbackOutputSchema = z.object({
    ok: z.boolean(),
    message: z.string(),
    reportId: z.string().optional(),
    receivedAt: z.string().optional(),
    email: z.string().optional(),
    code: z.enum(FEEDBACK_MCP_CODES).optional(),
});
const fmt = (n) => n.toLocaleString('en-US');
/** C1 section 5.4, measured in bytes. Returns the first breach as a plain sentence naming the limit, else null. */
export function checkFeedbackLimits(wire) {
    const files = wire.files ?? [];
    if (files.length > FEEDBACK_LIMITS.maxFiles)
        return `Too many files: at most ${FEEDBACK_LIMITS.maxFiles} per report.`;
    let total = 0;
    for (const f of files) {
        const bytes = Buffer.byteLength(f.content, 'utf8');
        if (bytes > FEEDBACK_LIMITS.maxFileBytes)
            return `A file is too large: at most ${fmt(FEEDBACK_LIMITS.maxFileBytes)} bytes per file.`;
        total += bytes;
    }
    if (total > FEEDBACK_LIMITS.maxTotalFileBytes)
        return `The files are too large together: at most ${fmt(FEEDBACK_LIMITS.maxTotalFileBytes)} bytes in total.`;
    // F-13323: control characters grow six-fold as JSON, so the whole body is measured too.
    if (Buffer.byteLength(JSON.stringify(wire), 'utf8') > FEEDBACK_LIMITS.maxBodyBytes) {
        return `The report is too large once encoded: at most ${fmt(FEEDBACK_LIMITS.maxBodyBytes)} bytes in total.`;
    }
    return null;
}
const FIXED = {
    invalid_request: 'The server did not accept the report. Check the fields and send again.',
    unauthenticated: 'Your sign-in was not accepted. Run phanos_login, then send again.',
    too_large: 'The report is too large. Send fewer or smaller files.',
    rate_limited: 'Too many reports in a short time. Wait a little, then send again.',
    server: 'The PhanOS server could not take the report right now. Try again later.',
    network: 'Could not reach the PhanOS server. Check the connection, then send again.',
    not_signed_in: 'Not signed in on this computer. Run phanos_login, then send again.',
};
const fail = (code, message) => ({ ok: false, code, message: message?.trim() ? message : FIXED[code] });
/** F-13322: the HTTP status decides the code; 0 is the transport's own "no response". */
function codeFor(status) {
    if (status === 400 || status === 415 || status === 422)
        return 'invalid_request';
    if (status === 401 || status === 403)
        return 'unauthenticated';
    if (status === 413)
        return 'too_large';
    if (status === 429)
        return 'rate_limited';
    if (status === 0)
        return 'network';
    return 'server';
}
export async function sendFeedback(deps, input) {
    const parsed = feedbackInputSchema.safeParse(input);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return fail('invalid_request', `The report is not valid. ${where}${issue?.message ?? 'unreadable input'}`);
    }
    const wire = parsed.data;
    const tooLarge = checkFeedbackLimits(wire);
    if (tooLarge)
        return fail('too_large', tooLarge);
    try {
        const session = await deps.getSession();
        if (!session)
            return fail('not_signed_in');
        const r = await deps.submit(session, wire);
        return { ok: true, message: `Report ${r.reportId} sent as ${r.email}.`, reportId: r.reportId, receivedAt: r.receivedAt, email: r.email };
    }
    catch (e) {
        if (e instanceof ApiError)
            return fail(codeFor(e.status), e.message);
        return fail('server');
    }
}
