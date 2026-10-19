export const DEFAULT_ASSISTANT_DISPLAY_NAME = '小叙' as const;

export type IdentityQueryTarget = 'ASSISTANT' | 'USER' | 'AMBIGUOUS' | 'NONE';

const INVALID_ASSISTANT_NAMES = new Set([
  '你', '我', '您', '助手', 'AI', 'AI助手', '机器人', '才对',
]);

/**
 * Resolve an explicit user request to rename the assistant for this session.
 * Ordinary mentions such as “你不是小叙吗” do not change the name.
 */
export function requestedAssistantDisplayName(text: string): string | null {
  const normalized = text.normalize('NFKC').trim();
  const patterns = [
    /(?:以后|从现在起|接下来)?(?:请)?(?:你|AI助手|这个助手)(?:应该|就|还是)?(?:改名为|改成|名字改成|名字叫|叫做|叫)\s*[“"'「]?([\p{Script=Han}A-Za-z0-9]{1,8}?)[”"'」]?(?:才对|吧|好吗|好不好|[。！？!?]|$)/u,
    /我(?:以后|想|要)?叫你\s*[“"'「]?([\p{Script=Han}A-Za-z0-9]{1,8}?)[”"'」]?(?:吧|好吗|好不好|[。！？!?]|$)/u,
  ];
  for (const pattern of patterns) {
    const candidate = pattern.exec(normalized)?.[1]?.trim();
    if (!candidate || INVALID_ASSISTANT_NAMES.has(candidate.toLocaleUpperCase('zh-CN'))) continue;
    return candidate;
  }
  return null;
}

/**
 * Resolve who an identity question refers to before the LLM sees it.
 * Chinese first-person and second-person identity questions are short and
 * high-impact, so leaving this distinction implicit can invert the answer.
 */
export function identityQueryTarget(text: string): IdentityQueryTarget {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '');
  const asksAboutUser = /(?:我是谁|你(?:还)?(?:知道|记得|认识)我是谁|我叫什么(?:名字)?|你(?:还)?记得我叫什么(?:名字)?)/u.test(normalized);
  const asksAboutAssistant = /(?:你是谁|你叫什么(?:名字)?|怎么称呼你|你是什么(?:AI)?助手|你的名字(?:是|叫)什么)/u.test(normalized);
  if (asksAboutUser && asksAboutAssistant) {
    // “我问的是我是谁，不是你是谁” is still a user-identity question.
    if (/(?:我问(?:的)?是|我想问|回答).{0,8}(?:我是谁|我叫什么)|不是你是谁/u.test(normalized)) return 'USER';
    return 'AMBIGUOUS';
  }
  if (asksAboutUser) return 'USER';
  if (asksAboutAssistant) return 'ASSISTANT';
  return 'NONE';
}

export function containsAssistantSelfIntroduction(text: string, displayName: string): boolean {
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[，。！？!?；;\\s])(?:您好?[，,\\s]*)?我是[“\"'「]?${escaped}[”\"'」]?`, 'u').test(text);
}
