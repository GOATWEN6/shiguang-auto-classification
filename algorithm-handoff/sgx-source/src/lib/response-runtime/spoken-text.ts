export interface ComposeSpokenTextInput {
  text: string;
  question: string | null;
  expectedQuestionCount?: 0 | 1;
}

const EMOTION_TERMS = /(温暖|暖|美好|幸福|开心|高兴|难过|伤心|痛苦|遗憾|骄傲|自豪|孤独|害怕|焦虑)/u;
const ASSERTIVE_EMOTION = new RegExp(
  `(?:一定|肯定|想必|显然|看来|听起来)[^。！？?]{0,18}${EMOTION_TERMS.source}`,
  'u',
);

/**
 * A model question must not turn an unconfirmed event into a fact. This is a
 * deliberately conservative, auditable v0.1 guard: it covers common event
 * presuppositions seen in the interview canary and falls back to a conditional
 * question when the current elder input does not provide the premise.
 */
export const INTERVIEW_PRECONDITION_GUARD_VERSION = 'interview-precondition-guard-v0.2' as const;
type EventPreconditionRule = {
  code: string;
  asserted: RegExp;
  evidence: RegExp;
  conditional: RegExp;
  negatedEvidence: RegExp;
  safeQuestion: string;
};

const EVENT_PRECONDITION_RULES: readonly EventPreconditionRule[] = [
  { code: 'FLOWERING', asserted: /(?:开(?:过|着)?花|开的花|花开|花香)/u,
    evidence: /(?:开(?:过|着)?花|开的花|花开|花香|花朵)/u,
    conditional: /(?:有没有|是否|是不是)[^。！？?]{0,6}(?:开(?:过|着)?花|开的花|花开|花香|花朵)|(?:如果|要是|假如|倘若)(?:后来|以后|曾经|有过|发生过|真的|确实|开过|有了|那时|当时)?(?:开(?:过|着)?花|开的花|花开|花香|花朵)/u,
    negatedEvidence: /(?:没有|没|从没|从来没有|一直没有|未曾|不曾)[^。！？?]{0,5}(?:开(?:过|着)?花|开的花|花开|花香|花朵)/u,
    safeQuestion: '如果后来开过花，您还记得当时是什么样吗？' },
  { code: 'MARRIAGE', asserted: /(?:结婚|结过婚|成家|婚礼|出嫁|嫁给|娶妻|娶了)/u,
    evidence: /(?:结婚|结过婚|成家|婚礼|出嫁|嫁给|娶妻|娶了)/u,
    conditional: /(?:有没有|是否|是不是)[^。！？?]{0,6}(?:结婚|结过婚|成家|婚礼|出嫁|嫁给|娶妻|娶了)|(?:如果|要是|假如|倘若)(?:后来|以后|曾经|有过|发生过|真的|确实|结过|成了家|办过婚礼)?(?:结婚|结过婚|成家|婚礼|出嫁|嫁给|娶妻|娶了)/u,
    negatedEvidence: /(?:没有|没|从没|从来没有|一直没有|未曾|不曾)[^。！？?]{0,5}(?:结婚|结过婚|成家|婚礼|出嫁|嫁给|娶妻|娶了)/u,
    safeQuestion: '如果后来有过成家或婚礼的经历，您还记得当时最重要的一件事吗？' },
  { code: 'GRADUATION', asserted: /(?:毕业|毕业典礼|读完书)/u,
    evidence: /(?:毕业|毕业典礼|读完书)/u,
    conditional: /(?:有没有|是否|是不是)[^。！？?]{0,6}(?:毕业|毕业典礼|读完书)|(?:如果|要是|假如|倘若)(?:后来|以后|曾经|有过|发生过|真的|确实)?(?:毕业|毕业典礼|读完书)/u,
    negatedEvidence: /(?:没有|没|从没|从来没有|一直没有|未曾|不曾)[^。！？?]{0,5}(?:毕业|毕业典礼|读完书)/u,
    safeQuestion: '如果后来有过毕业的经历，您还记得那时最重要的一件事吗？' },
  { code: 'CHILDREN', asserted: /(?:孩子|儿女|孙子|孙女)/u,
    evidence: /(?:孩子|儿女|孙子|孙女)/u,
    conditional: /(?:有没有|是否|是不是)[^。！？?]{0,6}(?:孩子|儿女|孙子|孙女)|(?:如果|要是|假如|倘若)(?:后来|以后|曾经|有过|发生过|真的|确实|有了)?(?:孩子|儿女|孙子|孙女)/u,
    negatedEvidence: /(?:没有|没|从没|从来没有|一直没有|未曾|不曾)[^。！？?]{0,5}(?:孩子|儿女|孙子|孙女)/u,
    safeQuestion: '如果后来有了孩子或孙辈，您愿意讲讲其中一件小事吗？' },
  { code: 'TRAVEL', asserted: /(?:旅行|旅游|出差|去过|游览)/u,
    evidence: /(?:旅行|旅游|出差|去过|游览)/u,
    conditional: /(?:有没有|是否|是不是)[^。！？?]{0,6}(?:旅行|旅游|出差|去过|游览)|(?:如果|要是|假如|倘若)(?:后来|以后|曾经|有过|发生过|真的|确实)?(?:旅行|旅游|出差|去过|游览)/u,
    negatedEvidence: /(?:没有|没|从没|从来没有|一直没有|未曾|不曾)[^。！？?]{0,5}(?:旅行|旅游|出差|去过|游览)/u,
    safeQuestion: '如果后来有过这样的出行，您还记得当时最特别的一件事吗？' },
];

export interface UnsupportedEventPrecondition {
  code: string;
  text: string;
  question: string;
}

/** Returns a safe conditional replacement, or null when the premise is supported. */
export function findUnsupportedEventPrecondition(
  responseText: string,
  elderInput: string,
  trustedEvidence: readonly string[] = [],
): UnsupportedEventPrecondition | null {
  for (const rule of EVENT_PRECONDITION_RULES) {
    if (!rule.asserted.test(responseText)) continue;
    // Only an event-local conditional qualifies. An unrelated phrase such as
    // “如果方便，您结婚那天……” must still be guarded.
    if (rule.conditional.test(responseText)) continue;
    const evidenceTexts = [elderInput, ...trustedEvidence];
    if (evidenceTexts.some(text => rule.negatedEvidence.test(text))) {
      return { code: rule.code, text: '好的，我们按您刚才的说明来。', question: '您愿意换一个话题聊聊吗？' };
    }
    const supported = evidenceTexts.some(text => rule.evidence.test(text));
    if (!supported) {
      return { code: rule.code, text: '关于您刚才提到的这件事，', question: rule.safeQuestion };
    }
  }
  return null;
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function questionMarks(value: string): number {
  return (value.match(/[?？]/gu) ?? []).length;
}

/** Produces the single user-visible string shared by subtitles and TTS. */
export function composeSpokenText(input: ComposeSpokenTextInput): string {
  const text = input.text.trim();
  const question = input.question?.trim() ?? '';
  if (!text) throw new TypeError('text must be non-empty');
  if (input.expectedQuestionCount === 0 && question) {
    throw new TypeError('question must be empty when expectedQuestionCount is 0');
  }
  if (input.expectedQuestionCount === 1 && !question) {
    throw new TypeError('question is required when expectedQuestionCount is 1');
  }
  if (question && questionMarks(text) > 0) {
    throw new TypeError('text must not contain a question when question is supplied separately');
  }
  if (questionMarks(question) > 1) throw new TypeError('question must contain at most one question');
  if (question && compact(text) === compact(question)) {
    throw new TypeError('text and question must not duplicate each other');
  }
  const spokenText = question ? `${text} ${question}` : text;
  if (questionMarks(spokenText) > 1) throw new TypeError('spokenText must contain at most one question');
  return spokenText;
}

/** Rejects assertive emotional interpretations unless the elder used that emotion term. */
export function hasUnsupportedEmotionAssertion(responseText: string, sourceText: string): boolean {
  const assertion = responseText.match(ASSERTIVE_EMOTION);
  if (!assertion) return false;
  const emotion = assertion[0].match(EMOTION_TERMS)?.[0];
  return Boolean(emotion && !sourceText.includes(emotion));
}
