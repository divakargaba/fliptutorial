import { z } from 'zod';
import { apiError, apiOrigin } from '../api';
import { ApiErrorSchema, type WorkerReply } from '../contracts';
import { FeedbackSchema, LevelSchema, PlanMessageSchema, RefresherSchema, responseSchemas, type PlanMessage } from './schemas';

export const LevelResultSchema = z.object({ accountId: z.string(), concept: z.string(), level: LevelSchema,
  levelName: z.string(), rank: z.number().int().positive(), xp: z.number().nonnegative(), strength: z.number().min(0).max(1) }).strict();
export const LevelsResultSchema = z.object({ accountId: z.string(), levels: z.record(z.string().min(1), LevelSchema) }).strict();
// What one delivered practice event earned (lane B1 GET /v2/profile/{accountId}/award/{eventId}).
const AwardLevelSchema = z.object({ level: LevelSchema, levelName: z.string().min(1), rank: z.number().int().positive(),
  minXp: z.number().nonnegative() }).strict();
export const AwardResultSchema = z.object({
  accountId: z.string(), eventId: z.string(), type: z.string(), totalXpGained: z.number(), leveledUp: z.boolean(),
  awards: z.array(z.object({
    concept: z.string().min(1), conceptName: z.string(), primary: z.boolean(), xpGained: z.number(),
    xpBefore: z.number().nonnegative(), xp: z.number().nonnegative(), levelBefore: AwardLevelSchema, level: AwardLevelSchema,
    nextLevel: AwardLevelSchema.nullable(), xpToNext: z.number().nonnegative(), progress: z.number().min(0).max(1),
    leveledUp: z.boolean(),
  }).strict()).max(20),
}).strict();
const deadline = (type: PlanMessage['type']) => type === 'levelV2' || type === 'levelsV2' || type === 'awardV2' ? 3000 : 20000;
const EventAckSchema = z.object({ accepted: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })) });

// This allowlist is the only mapping from runtime messages to network paths.
// Never accept a caller-supplied URL, account cookie, header or redirect.
export async function requestPlanApi(raw: unknown, base: string, fetcher: typeof fetch = fetch): Promise<WorkerReply<unknown>> {
  const parsed = PlanMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: apiError('INVALID_REQUEST', 'Invalid practice request.', false) };
  const m = parsed.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline(m.type));
  try {
    const { type, ...body } = m;
    const get = type === 'pollPlan' || type === 'levelV2' || type === 'levelsV2' || type === 'refresherV2' || type === 'awardV2';
    const path = m.type === 'pollPlan' ? `/v2/plan/${encodeURIComponent(m.videoId)}`
      : m.type === 'levelV2' ? `/v2/profile/${encodeURIComponent(m.accountId)}/level/${encodeURIComponent(m.concept)}`
      : m.type === 'levelsV2' ? `/v2/profile/${encodeURIComponent(m.accountId)}/levels`
      : m.type === 'refresherV2' ? `/v2/refresher/${encodeURIComponent(m.accountId)}`
      : m.type === 'awardV2' ? `/v2/profile/${encodeURIComponent(m.accountId)}/award/${encodeURIComponent(m.eventId)}`
      : { plan: '/v2/plan', submitV2: '/v2/submit', answerV2: '/v2/answer', hintV2: '/v2/hint', eventsV2: '/v2/events' }[m.type];
    const response = await fetcher(apiOrigin(base) + path, {
      method: get ? 'GET' : 'POST', ...(get ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    if (response.ok && m.type === 'eventsV2') {
      if (response.status === 204) return { ok: true, data: { acknowledgedIds: m.events.map(e => e.id) } };
      // B1 accepts events individually: an HTTP 200 alone is not proof that
      // every event was stored. Preserve rejected or unaccounted-for records.
      const ack = EventAckSchema.safeParse(await response.json());
      const sent = new Set(m.events.map(e => e.id));
      if (!ack.success || ack.data.accepted + ack.data.duplicates + ack.data.rejected.length !== m.events.length ||
          new Set(ack.data.rejected.map(e => e.id)).size !== ack.data.rejected.length || ack.data.rejected.some(e => !sent.has(e.id))) {
        return { ok: false, error: apiError('INVALID_RESPONSE', 'Could not confirm stored practice events.') };
      }
      const rejected = new Set(ack.data.rejected.map(e => e.id));
      return { ok: true, data: { acknowledgedIds: m.events.filter(e => !rejected.has(e.id)).map(e => e.id) } };
    }
    if (response.status === 204 && m.type === 'refresherV2') return { ok: true, data: null };
    const json: unknown = await response.json();
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(json);
      return { ok: false, error: error.success ? error.data : apiError('API_ERROR', 'Practice is temporarily unavailable.') };
    }
    if (m.type === 'refresherV2') {
      const pick = RefresherSchema.safeParse(json);
      if (!pick.success || !pick.data || pick.data.accountId !== m.accountId) {
        return { ok: false, error: apiError('INVALID_RESPONSE', 'Invalid refresher for this learner.') };
      }
      return { ok: true, data: pick.data };
    }
    const schema = m.type === 'levelV2' ? LevelResultSchema : m.type === 'levelsV2' ? LevelsResultSchema
      : m.type === 'awardV2' ? AwardResultSchema
      : responseSchemas[m.type as keyof typeof responseSchemas];
    const result = schema.safeParse(json);
    if (!result.success) return { ok: false, error: apiError('INVALID_RESPONSE', 'Invalid practice response.') };
    const data = result.data;
    if ((m.type === 'levelV2' || m.type === 'levelsV2') && (!('accountId' in data) || data.accountId !== m.accountId ||
        (m.type === 'levelV2' && (!('concept' in data) || data.concept !== m.concept)))) {
      return { ok: false, error: apiError('INVALID_RESPONSE', 'Level belongs to a different learner or concept.') };
    }
    if (m.type === 'awardV2' && (!('eventId' in data) || data.accountId !== m.accountId || data.eventId !== m.eventId)) {
      return { ok: false, error: apiError('INVALID_RESPONSE', 'Award belongs to a different learner or event.') };
    }
    if ((m.type === 'plan' || m.type === 'pollPlan') && (!('videoId' in data) || data.videoId !== m.videoId)) {
      return { ok: false, error: apiError('INVALID_RESPONSE', 'Plan belongs to a different video.') };
    }
    const feedback = FeedbackSchema.safeParse('feedback' in data ? data.feedback : null);
    if ((m.type === 'submitV2' || m.type === 'answerV2') && (!feedback.success ||
        feedback.data.exerciseId !== (m.type === 'submitV2' ? m.exerciseId : m.questionId))) {
      return { ok: false, error: apiError('INVALID_RESPONSE', 'Feedback belongs to a different exercise.') };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: apiError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', 'Cannot load practice. Playback remains available.') };
  } finally { clearTimeout(timer); }
}

export async function sendPlanRequest<T>(message: PlanMessage, schema: z.ZodType<T>, send: (message: PlanMessage) => Promise<unknown>): Promise<WorkerReply<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendWhenReady = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await send(message); }
      catch (error) {
        // A cold MV3 listener can race the page. Retry only when the browser
        // confirms no receiver existed; never retry a possibly applied submit.
        if (!['plan', 'pollPlan', 'levelV2', 'levelsV2', 'refresherV2', 'awardV2'].includes(message.type) || attempt >= 2 ||
            !(error instanceof Error) || !error.message.includes('Receiving end does not exist')) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 100 : 300));
      }
    }
  };
  try {
    const reply = await Promise.race([sendWhenReady(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), deadline(message.type) + 500); })]);
    const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: schema }),
      z.object({ ok: z.literal(false), error: ApiErrorSchema })]).safeParse(reply);
    return result.success ? result.data : { ok: false, error: apiError('INVALID_RESPONSE', 'Invalid extension reply.') };
  } catch { return { ok: false, error: apiError('NETWORK', 'Practice is temporarily unavailable.') }; }
  finally { clearTimeout(timer); }
}
